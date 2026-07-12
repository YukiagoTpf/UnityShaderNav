import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { CacheManager, chooseCacheDir } from '../../src/cache/cacheManager';
import { CacheStore } from '../../src/cache/cacheStore';
import { Workspace } from '../../src/workspace/workspace';
import { WorkspaceIndex } from '../../src/workspace/workspaceIndex';
import {
  DefaultIndexedRevisionCandidateConstructor,
  type DefaultIndexedRevisionCandidateConstructorOptions,
  type IndexedRevisionCandidateConstructionInput,
  type IndexedRevisionCandidateConstructor,
} from '../../src/workspace/indexedRevisionCandidate';
import type { IndexedRevisionBuilder } from '../../src/workspace/indexedRevision';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import {
  copyUnityProjectFixture,
  removeCopiedUnityProject,
} from '../helpers/copiedUnityProject';

const projectASource = resolve(__dirname, '../include/fixtures/projectA');
let projectA: string;

const fakeConnection = {
  console: { log() {}, warn() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  }
  throw new Error('condition was not met');
}

type CandidateConstructionProceed = () => Promise<IndexedRevisionBuilder>;

function interceptCandidateConstruction(
  options: DefaultIndexedRevisionCandidateConstructorOptions,
  interceptor: (
    proceed: CandidateConstructionProceed,
    input: IndexedRevisionCandidateConstructionInput,
  ) => Promise<IndexedRevisionBuilder>,
) {
  const delegate = new DefaultIndexedRevisionCandidateConstructor(options);
  return {
    construct: vi.fn((input) => interceptor(() => delegate.construct(input), input)),
  } satisfies IndexedRevisionCandidateConstructor;
}

function snapshot(
  uri: string,
  text: string,
  version = 1,
  openId = 1,
): IndexedDocumentSnapshot {
  return { uri, text, version, openId, languageId: 'hlsl' };
}

function positionOf(text: string, needle: string): { line: number; character: number } {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`Missing test token: ${needle}`);
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function hasWorkspaceSymbol(workspace: Workspace, name: string): boolean {
  return workspace.workspaceSymbols(name).some((symbol) => symbol.name === name);
}

function unityCachePath(root: string, folderUri = pathToFileURL(root).href): string {
  const dir = chooseCacheDir({
    unityProjectRoot: root,
    workspaceFolderUri: folderUri,
    globalStorageDir: undefined,
  });
  if (!dir) throw new Error('Expected a Unity workspace cache directory');
  return join(dir, 'index.json');
}

async function hasDocumentSymbol(
  workspace: Workspace,
  uri: string,
  name: string,
): Promise<boolean> {
  const symbols = await workspace.documentSymbols({ uri });
  const pending = [...(symbols ?? [])];
  while (pending.length > 0) {
    const symbol = pending.pop()!;
    if (symbol.name === name) return true;
    pending.push(...(symbol.children ?? []));
  }
  return false;
}

beforeEach(async () => {
  projectA = await copyUnityProjectFixture(projectASource);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeCopiedUnityProject(projectA);
});

describe('Workspace candidate publication', () => {
  it('publishes an observable revision for initialization and rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lifecycle-ready-'));
    const changed = vi.fn();
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        onIndexStatusChanged: changed,
      });

      await workspace.initialize(fakeConnection);
      expect(workspace.indexStatus()).toEqual({
        folderUri: pathToFileURL(root).href,
        mode: 'standalone',
        lifecycle: { state: 'ready', revision: 1, warningCount: 0 },
      });

      await workspace.rebuild(fakeConnection);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 0,
      });
      expect(changed).toHaveBeenCalledTimes(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not publish a terminal lifecycle after disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lifecycle-disposed-'));
    const initial = deferred();
    const changed = vi.fn();
    try {
      const folderUri = pathToFileURL(root).href;
      const candidateConstructor = interceptCandidateConstruction({
        folderUri,
        ensureParserReady: async () => {},
        indexImplementation: null,
      }, async (proceed) => {
        await initial.promise;
        return proceed();
      });
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        candidateConstructor,
        onIndexStatusChanged: changed,
      });

      const initializing = workspace.initialize(fakeConnection);
      await flushPromises();
      workspace.dispose();
      initial.resolve();
      await initializing;

      expect(workspace.canServe()).toBe(false);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'indexing',
        operation: 'initial',
      });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prevents a disposed workspace from saving after cache snapshots drain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-disposed-'));
    await mkdir(join(root, 'Assets'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    const shaderPath = join(root, 'Assets', 'Cached.hlsl');
    await writeFile(shaderPath, 'float4 CachedSymbol() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await workspace.initialize(fakeConnection);
      const snapshotStarted = deferred();
      const releaseSnapshot = deferred();
      vi.spyOn(CacheManager.prototype, 'snapshot').mockImplementation(async () => {
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
        return null;
      });
      const save = vi.spyOn(CacheStore.prototype, 'save');

      const persisting = workspace.persist();
      await snapshotStarted.promise;
      workspace.dispose();
      releaseSnapshot.resolve();
      await persisting;

      expect(save).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets a later candidate build proceed while an immutable revision is being persisted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-serialized-'));
    await mkdir(join(root, 'Assets'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');

    try {
      const folderUri = pathToFileURL(root).href;
      const candidateConstructor = interceptCandidateConstruction(
        { folderUri },
        (proceed) => proceed(),
      );
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, { candidateConstructor });
      await workspace.initialize(fakeConnection);
      candidateConstructor.construct.mockClear();
      const saveStarted = deferred();
      const releaseSave = deferred();
      const save = vi.spyOn(CacheStore.prototype, 'save').mockImplementation(async () => {
        saveStarted.resolve();
        await releaseSave.promise;
      });
      const persisting = workspace.persist();
      await saveStarted.promise;
      const rebuilding = workspace.rebuild(fakeConnection);
      await flushPromises();
      expect(candidateConstructor.construct).toHaveBeenCalledTimes(1);

      releaseSave.resolve();
      await Promise.all([rebuilding, persisting]);
      expect(save).toHaveBeenCalledTimes(2);
      expect(candidateConstructor.construct).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips queued reconfiguration after disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-disposed-queue-'));
    try {
      const folderUri = pathToFileURL(root).href;
      const rebuildGate = deferred();
      let constructionCount = 0;
      const candidateConstructor = interceptCandidateConstruction({
        folderUri,
        ensureParserReady: async () => {},
        indexImplementation: null,
      }, async (proceed) => {
        const constructionNumber = ++constructionCount;
        const candidate = await proceed();
        if (constructionNumber === 2) await rebuildGate.promise;
        return candidate;
      });
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, { candidateConstructor });
      await workspace.initialize(fakeConnection);

      const rebuilding = workspace.rebuild(fakeConnection);
      const nextSettings = { ...DEFAULT_SETTINGS, debug: { definitionTrace: true } };
      const reconfiguring = workspace.reconfigure(fakeConnection, nextSettings);
      await flushPromises();
      workspace.dispose();
      rebuildGate.resolve();
      await Promise.all([rebuilding, reconfiguring]);

      expect(workspace.settings.debug.definitionTrace).toBe(false);
      expect(workspace.canServe()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces parser initialization failure and permits recovery in one process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lifecycle-parser-'));
    let attempts = 0;
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {
          attempts++;
          if (attempts === 1) throw new Error('grammar WASM unavailable');
        },
      });

      await expect(workspace.initialize(fakeConnection)).rejects.toThrow(
        'Unable to initialize the shader parser: grammar WASM unavailable',
      );
      expect(workspace.indexStatus()).toMatchObject({
        mode: 'standalone',
        lifecycle: {
          state: 'failed',
          failure: {
            category: 'parser-initialization',
            message: 'Unable to initialize the shader parser: grammar WASM unavailable',
          },
        },
      });

      await workspace.rebuild(fakeConnection);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 1,
        warningCount: 0,
      });
      expect(attempts).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed JSON', '{broken json'],
    [
      'an incomplete known source',
      JSON.stringify({
        dependencies: {
          'com.example.git': {
            source: 'git',
            version: 'https://example.com/repo.git',
          },
        },
      }),
    ],
  ])('surfaces %s Unity package state with actionable context', async (_case, lockfile) => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lifecycle-package-'));
    await mkdir(join(root, 'Assets'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), lockfile);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
      });

      await expect(workspace.initialize(fakeConnection)).rejects.toThrow(
        /Invalid Packages\/packages-lock\.json/,
      );
      expect(workspace.indexStatus()).toMatchObject({
        mode: 'unity',
        lifecycle: {
          state: 'failed',
          failure: {
            category: 'package-resolution',
            message: expect.stringContaining('Invalid Packages/packages-lock.json'),
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes source read skips as warnings instead of a false clean revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lifecycle-warning-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'Assets', 'Shaders', 'Unreadable.hlsl'), 'float4 Skipped();');
    vi.spyOn(WorkspaceIndex.prototype, 'indexAndStore').mockResolvedValue(false);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(fakeConnection);

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 1,
        warningCount: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces indexing-engine failures instead of publishing ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lifecycle-index-failure-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'Assets', 'Shaders', 'Broken.hlsl'), 'float4 Broken();');
    vi.spyOn(WorkspaceIndex.prototype, 'indexAndStore')
      .mockRejectedValue(new Error('parser engine panic'));

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });

      await expect(workspace.initialize(fakeConnection)).rejects.toThrow('parser engine panic');
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'failed',
        failure: { category: 'indexing', message: 'parser engine panic' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes overlapping rebuild requests before publishing each revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lifecycle-serialized-'));
    try {
      const folderUri = pathToFileURL(root).href;
      const first = deferred();
      const second = deferred();
      let constructionCount = 0;
      const candidateConstructor = interceptCandidateConstruction({
        folderUri,
        ensureParserReady: async () => {},
        indexImplementation: null,
      }, async (proceed) => {
        const constructionNumber = ++constructionCount;
        const candidate = await proceed();
        if (constructionNumber === 2) await first.promise;
        if (constructionNumber === 3) await second.promise;
        return candidate;
      });
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, { candidateConstructor });
      await workspace.initialize(fakeConnection);
      candidateConstructor.construct.mockClear();

      const firstRebuild = workspace.rebuild(fakeConnection);
      await flushPromises();
      const secondRebuild = workspace.rebuild(fakeConnection);
      await flushPromises();

      expect(candidateConstructor.construct).toHaveBeenCalledTimes(1);
      expect(workspace.indexStatus().lifecycle).toMatchObject({
        state: 'indexing',
        operation: 'rebuild',
      });

      first.resolve();
      await firstRebuild;
      await waitFor(() => candidateConstructor.construct.mock.calls.length === 2);
      expect(candidateConstructor.construct).toHaveBeenCalledTimes(2);
      expect(workspace.indexStatus().lifecycle).toMatchObject({
        state: 'indexing',
        operation: 'rebuild',
      });

      second.resolve();
      await Promise.all([firstRebuild, secondRebuild]);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 3,
        warningCount: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not apply settings in the middle of an active rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-settings-serialized-'));
    try {
      const folderUri = pathToFileURL(root).href;
      const rebuilding = deferred();
      let constructionCount = 0;
      const candidateConstructor = interceptCandidateConstruction({
        folderUri,
        ensureParserReady: async () => {},
        indexImplementation: null,
      }, async (proceed) => {
        const constructionNumber = ++constructionCount;
        const candidate = await proceed();
        if (constructionNumber === 2) await rebuilding.promise;
        return candidate;
      });
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, { candidateConstructor });
      await workspace.initialize(fakeConnection);

      const rebuild = workspace.rebuild(fakeConnection);
      await flushPromises();
      const nextSettings = {
        ...DEFAULT_SETTINGS,
        debug: { definitionTrace: true },
      };
      const update = workspace.reconfigure(fakeConnection, nextSettings);
      await flushPromises();

      expect(workspace.settings.debug.definitionTrace).toBe(false);
      rebuilding.resolve();
      await Promise.all([rebuild, update]);
      expect(workspace.settings.debug.definitionTrace).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips queued incremental changes when the preceding rebuild fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-failed-queue-'));
    try {
      const folderUri = pathToFileURL(root).href;
      let constructionCount = 0;
      const candidateConstructor = interceptCandidateConstruction({
        folderUri,
        ensureParserReady: async () => {},
        indexImplementation: null,
      }, async (proceed) => {
        constructionCount++;
        if (constructionCount === 2) throw new Error('rebuild infrastructure failed');
        return proceed();
      });
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, { candidateConstructor });
      await workspace.initialize(fakeConnection);

      const rebuild = workspace.rebuild(fakeConnection);
      const incremental = workspace.applyChanges(
        [{ uri: pathToFileURL(join(root, 'Changed.hlsl')).href, type: 'changed' }],
        fakeConnection,
      );

      await expect(rebuild).rejects.toThrow('rebuild infrastructure failed');
      await expect(incremental).resolves.toBeUndefined();
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'failed',
        servingRevision: 1,
        failure: { category: 'indexing', message: 'rebuild infrastructure failed' },
      });
      expect(workspace.canServe()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('indexes user files and Packages into the global index', async () => {
    const folder = pathToFileURL(projectA).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);
    const packageUri = pathToFileURL(
      join(projectA, 'Packages', 'com.example.urp', 'ShaderLibrary', 'Core.hlsl'),
    ).href;

    await workspace.initialize(fakeConnection);

    expect(workspace.isStandalone()).toBe(false);
    expect(hasWorkspaceSymbol(workspace, 'Common')).toBe(true);
    expect(await hasDocumentSymbol(workspace, packageUri, 'Core')).toBe(true);
  });

  it('indexes user files and Packages into the global reference index', async () => {
    const projectRoot = projectA;
    const folder = pathToFileURL(projectRoot).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.initialize(fakeConnection);

    const mainUri = pathToFileURL(join(projectRoot, 'Assets', 'Shaders', 'Main.shader')).href;
    const text = await readFile(join(projectRoot, 'Assets', 'Shaders', 'Main.shader'), 'utf8');
    const refs = await workspace.referencesAt({
      document: snapshot(mainUri, text),
      position: positionOf(text, 'Core();'),
      includeDeclaration: false,
    });
    expect(refs?.some((ref) => ref.uri.endsWith('/Assets/Shaders/Main.shader'))).toBe(true);
  });

  it('writes cache on first initialization and restores it on the second initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-initialize-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'Assets', 'Shaders', 'Cached.hlsl'), 'float4 CachedSymbol() { return 0; }');

    try {
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws1.initialize(fakeConnection);

      const cachePath = unityCachePath(root);
      const manifest = JSON.parse(await readFile(cachePath, 'utf8'));
      expect(manifest.files.length).toBeGreaterThanOrEqual(1);

      const restore = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.initialize(fakeConnection);

      expect(restore).toHaveBeenCalled();
      expect(hasWorkspaceSymbol(ws2, 'CachedSymbol')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuilds and replaces a cache produced by a different index implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-implementation-mismatch-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    const shaderPath = join(root, 'Assets', 'Shaders', 'Current.hlsl');
    const source = 'float4 CurrentImplementation() { return 0; }';
    await writeFile(shaderPath, source);

    try {
      const folderUri = pathToFileURL(root).href;
      const first = new Workspace(folderUri, DEFAULT_SETTINGS);
      await first.initialize(fakeConnection);

      const cachePath = unityCachePath(root, folderUri);
      const manifest = JSON.parse(await readFile(cachePath, 'utf8'));
      const persistedIdentity = manifest.fingerprint.indexImplementation as string;
      const staleIdentity = persistedIdentity === 'a'.repeat(64)
        ? 'b'.repeat(64)
        : 'a'.repeat(64);
      manifest.fingerprint.indexImplementation = staleIdentity;
      await writeFile(cachePath, JSON.stringify(manifest), 'utf8');

      const restore = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      const second = new Workspace(folderUri, DEFAULT_SETTINGS);
      await second.initialize(fakeConnection);

      expect(restore).not.toHaveBeenCalled();
      expect(hasWorkspaceSymbol(second, 'CurrentImplementation')).toBe(true);
      expect(await readFile(shaderPath, 'utf8')).toBe(source);

      const rewritten = JSON.parse(await readFile(cachePath, 'utf8'));
      expect(rewritten.fingerprint.indexImplementation).toBe(persistedIdentity);
      expect(rewritten.fingerprint.indexImplementation).not.toBe(staleIdentity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps source indexing usable while cache identity is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-identity-unavailable-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(
      join(root, 'Assets', 'Shaders', 'NoCache.hlsl'),
      'float4 SourceStillWorks() { return 0; }',
    );
    const warning = vi.fn();
    const connection = {
      ...fakeConnection,
      console: { ...fakeConnection.console, warn: warning },
    } as never;

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
      });
      await workspace.initialize(connection);

      expect(hasWorkspaceSymbol(workspace, 'SourceStillWorks')).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('cache disabled'));
      await expect(readFile(
        unityCachePath(root),
        'utf8',
      )).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to full scan when the persisted manifest schema is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-invalid-schema-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'Assets', 'Shaders', 'Recovered.hlsl'), 'float4 RecoveredSymbol() { return 0; }');

    try {
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws1.initialize(fakeConnection);

      const cachePath = unityCachePath(root);
      const { files: _files, ...corruptedManifest } = JSON.parse(await readFile(cachePath, 'utf8'));
      await writeFile(cachePath, JSON.stringify(corruptedManifest), 'utf8');

      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await workspace.initialize(fakeConnection);

      expect(hasWorkspaceSymbol(workspace, 'RecoveredSymbol')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists opened standalone files into global storage and restores them on next initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-standalone-cache-'));
    const globalStorageDir = await mkdtemp(join(tmpdir(), 'usn-global-storage-'));
    const shaderPath = join(root, 'Loose.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 StandaloneCached() { return 0; }');

    try {
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws1.initialize(fakeConnection, globalStorageDir);
      await ws1.updateDocument(snapshot(shaderUri, await readFile(shaderPath, 'utf8')));
      await ws1.persist();

      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.initialize(fakeConnection, globalStorageDir);

      expect(ws2.isStandalone()).toBe(true);
      expect(hasWorkspaceSymbol(ws2, 'StandaloneCached')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(globalStorageDir, { recursive: true, force: true });
    }
  });

  it('does not persist unsaved standalone overlays as disk cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-standalone-unsaved-cache-'));
    const globalStorageDir = await mkdtemp(join(tmpdir(), 'usn-global-storage-'));
    const shaderPath = join(root, 'Loose.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 SavedOnly() { return 0; }');

    try {
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws1.initialize(fakeConnection, globalStorageDir);
      await ws1.updateDocument(snapshot(shaderUri, 'float4 UnsavedOnly() { return 0; }'));
      await ws1.persist();

      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.initialize(fakeConnection, globalStorageDir);

      expect(hasWorkspaceSymbol(ws2, 'UnsavedOnly')).toBe(false);
      expect(hasWorkspaceSymbol(ws2, 'SavedOnly')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(globalStorageDir, { recursive: true, force: true });
    }
  });

  it('persists cached file records in deterministic uri order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-standalone-sorted-cache-'));
    const globalStorageDir = await mkdtemp(join(tmpdir(), 'usn-global-storage-'));
    const folderUri = pathToFileURL(root).href;
    const aPath = join(root, 'A.hlsl');
    const bPath = join(root, 'B.hlsl');
    const aUri = pathToFileURL(aPath).href;
    const bUri = pathToFileURL(bPath).href;
    await writeFile(aPath, 'float4 A() { return 0; }');
    await writeFile(bPath, 'float4 B() { return 0; }');

    try {
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS);
      await workspace.initialize(fakeConnection, globalStorageDir);
      await workspace.updateDocument(snapshot(bUri, await readFile(bPath, 'utf8')));
      await workspace.updateDocument(snapshot(aUri, await readFile(aPath, 'utf8')));
      await workspace.persist();

      const cacheDir = chooseCacheDir({
        unityProjectRoot: undefined,
        workspaceFolderUri: folderUri,
        globalStorageDir,
      });
      const manifest = JSON.parse(await readFile(join(cacheDir!, 'index.json'), 'utf8'));

      expect(manifest.files.map((file: { uri: string }) => file.uri)).toEqual([aUri, bUri]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(globalStorageDir, { recursive: true, force: true });
    }
  });

  it('does not restore cached package files no longer covered by packages-lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-package-cache-filter-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    const oldPackageRoot = join(root, 'Library', 'PackageCache', 'com.example.render@oldhash');
    const newPackageRoot = join(root, 'Library', 'PackageCache', 'com.example.render@newhash');
    const oldPackageUri = pathToFileURL(join(oldPackageRoot, 'Old.hlsl')).href;
    const newPackageUri = pathToFileURL(join(newPackageRoot, 'New.hlsl')).href;
    await mkdir(oldPackageRoot, { recursive: true });
    await mkdir(newPackageRoot, { recursive: true });
    await writeFile(join(oldPackageRoot, 'Old.hlsl'), 'float4 OldPackageSymbol() { return 0; }');
    await writeFile(join(newPackageRoot, 'New.hlsl'), 'float4 NewPackageSymbol() { return 0; }');

    const writeLockfile = async (hash: string) => writeFile(
      join(root, 'Packages', 'packages-lock.json'),
      JSON.stringify({
        dependencies: {
          'com.example.render': {
            version: '1.0.0',
            source: 'registry',
            hash,
          },
        },
      }),
    );

    try {
      await writeLockfile('oldhash');
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws1.initialize(fakeConnection);
      expect(await hasDocumentSymbol(ws1, oldPackageUri, 'OldPackageSymbol')).toBe(true);

      await writeLockfile('newhash');
      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.initialize(fakeConnection);

      expect(await hasDocumentSymbol(ws2, oldPackageUri, 'OldPackageSymbol')).toBe(false);
      expect(await hasDocumentSymbol(ws2, newPackageUri, 'NewPackageSymbol')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores the full-scan index when a scanned file is opened and closed', async () => {
    const projectRoot = projectA;
    const folder = pathToFileURL(projectRoot).href;
    const commonUri = pathToFileURL(join(projectRoot, 'Assets', 'Shaders', 'Common.hlsl')).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.initialize(fakeConnection);
    expect(hasWorkspaceSymbol(workspace, 'Common')).toBe(true);

    await workspace.updateDocument(snapshot(commonUri, 'float4 LiveOnly() { return 0; }'));
    expect(hasWorkspaceSymbol(workspace, 'Common')).toBe(false);
    expect(hasWorkspaceSymbol(workspace, 'LiveOnly')).toBe(true);

    await workspace.closeDocument({ uri: commonUri, openId: 1 });

    expect(hasWorkspaceSymbol(workspace, 'Common')).toBe(true);
    expect(hasWorkspaceSymbol(workspace, 'LiveOnly')).toBe(false);
  });

  it('keeps reference queries in sync with live updates and close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-refs-'));
    const shaderPath = join(root, 'Loose.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 SavedOnly() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await workspace.initialize(fakeConnection);

      const withReference = 'float4 Target() { return 0; }\nfloat4 Caller() { return Target(); }';
      const withoutReference = 'float4 Target() { return 0; }\nfloat4 Caller() { return 0; }';
      const first = snapshot(shaderUri, withReference, 1);
      const second = snapshot(shaderUri, withoutReference, 2);
      await workspace.updateDocument(first);
      expect(await workspace.referencesAt({
        document: first,
        position: positionOf(withReference, 'Target()'),
        includeDeclaration: false,
      })).toHaveLength(1);

      await workspace.updateDocument(second);
      expect(await workspace.referencesAt({
        document: second,
        position: positionOf(withoutReference, 'Target()'),
        includeDeclaration: false,
      })).toEqual([]);

      await workspace.closeDocument({ uri: shaderUri, openId: 1 });
      expect(hasWorkspaceSymbol(workspace, 'SavedOnly')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects references under package roots', async () => {
    const projectRoot = projectA;
    const workspace = new Workspace(pathToFileURL(projectRoot).href, DEFAULT_SETTINGS);
    await workspace.initialize(fakeConnection);

    const packageUri = pathToFileURL(
      join(projectRoot, 'Packages', 'com.example.urp', 'ShaderLibrary', 'Core.hlsl'),
    ).href;
    const userUri = pathToFileURL(join(projectRoot, 'Assets', 'Shaders', 'Main.shader')).href;

    expect(workspace.packages.isInPackages(packageUri)).toBe(true);
    expect(workspace.packages.isInPackages(userUri)).toBe(false);
  });

  it('uses settings.projectRoot when the workspace folder is not a Unity root', async () => {
    const projectRoot = projectA;
    const folder = pathToFileURL(await mkdtemp(join(tmpdir(), 'usn-non-root-'))).href;
    const workspace = new Workspace(folder, {
      ...DEFAULT_SETTINGS,
      projectRoot,
    });

    await workspace.initialize(fakeConnection);

    expect(workspace.isStandalone()).toBe(false);
    expect(workspace.unityRoot).toBe(projectRoot);
    expect(hasWorkspaceSymbol(workspace, 'Common')).toBe(true);
    expect(await hasDocumentSymbol(
      workspace,
      pathToFileURL(
        join(projectRoot, 'Packages', 'com.example.urp', 'ShaderLibrary', 'Core.hlsl'),
      ).href,
      'Core',
    )).toBe(true);
  });

  it('applies a changed event by re-reading the file from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-apply-change-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    const shaderPath = join(root, 'Assets', 'Shaders', 'Common.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 BeforeChange() { return 0; }');

    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
    await workspace.initialize(fakeConnection);
    expect(hasWorkspaceSymbol(workspace, 'BeforeChange')).toBe(true);

    await writeFile(shaderPath, 'float4 AfterChange() { return 1; }');
    await workspace.applyChanges([{ uri: shaderUri, type: 'changed' }], fakeConnection);

    expect(hasWorkspaceSymbol(workspace, 'BeforeChange')).toBe(false);
    expect(hasWorkspaceSymbol(workspace, 'AfterChange')).toBe(true);
  });

  it('drops deleted files from the live and global indexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-delete-change-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    const shaderPath = join(root, 'Assets', 'Shaders', 'Deleted.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 DeletedSymbol() { return 0; }');

    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
    await workspace.initialize(fakeConnection);
    expect(hasWorkspaceSymbol(workspace, 'DeletedSymbol')).toBe(true);

    await unlink(shaderPath);
    await workspace.applyChanges([{ uri: shaderUri, type: 'deleted' }], fakeConnection);

    expect(await workspace.documentSymbols({ uri: shaderUri })).toBeNull();
    expect(hasWorkspaceSymbol(workspace, 'DeletedSymbol')).toBe(false);
  });

  it('rebuild clears stale indexes and reloads Packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-rebuild-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    const shaderPath = join(root, 'Assets', 'Shaders', 'Common.hlsl');
    await writeFile(shaderPath, 'float4 BeforeRebuild() { return 0; }');

    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
    await workspace.initialize(fakeConnection);
    expect(hasWorkspaceSymbol(workspace, 'BeforeRebuild')).toBe(true);

    await writeFile(shaderPath, 'float4 AfterRebuild() { return 1; }');
    await workspace.rebuild(fakeConnection);

    expect(hasWorkspaceSymbol(workspace, 'BeforeRebuild')).toBe(false);
    expect(hasWorkspaceSymbol(workspace, 'AfterRebuild')).toBe(true);
    expect(workspace.packages.hasResolver()).toBe(true);
  });
});

describe('Workspace.reconfigure', () => {
  it('rebuilds the macro table and updates settings together when declarationMacros change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-reconfigure-macros-'));
    const shaderUri = pathToFileURL(join(root, 'Configured.hlsl')).href;
    const text = 'MY_TEX(_Configured)';
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(fakeConnection);
      await workspace.updateDocument(snapshot(shaderUri, text));
      expect(hasWorkspaceSymbol(workspace, '_Configured')).toBe(false);

      await workspace.reconfigure(fakeConnection, {
        ...DEFAULT_SETTINGS,
        declarationMacros: [{ pattern: 'MY_TEX($name)', kind: 'variable' }],
      });

      expect(workspace.settings.declarationMacros).toHaveLength(1);
      expect(hasWorkspaceSymbol(workspace, '_Configured')).toBe(true);
      expect(workspace.indexStatus().lifecycle).toMatchObject({ state: 'ready', revision: 3 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
