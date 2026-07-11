import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { CacheManager, chooseCacheDir } from '../../src/cache/cacheManager';
import { Workspace } from '../../src/workspace/workspace';
import { WorkspaceIndex } from '../../src/workspace/workspaceIndex';
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

beforeEach(async () => {
  projectA = await copyUnityProjectFixture(projectASource);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeCopiedUnityProject(projectA);
});

describe('Workspace.bootstrap', () => {
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
    const initial = deferred<number>();
    const changed = vi.fn();
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
        onIndexStatusChanged: changed,
      });
      vi.spyOn(workspace, 'bootstrap').mockReturnValue(initial.promise);

      const initializing = workspace.initialize(fakeConnection);
      await flushPromises();
      workspace.dispose();
      initial.resolve(0);
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
      const save = vi.spyOn(CacheManager.prototype, 'save');

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

  it('serializes a later index mutation behind active public persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-serialized-'));
    await mkdir(join(root, 'Assets'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await workspace.initialize(fakeConnection);
      const saveStarted = deferred();
      const releaseSave = deferred();
      const save = vi.spyOn(CacheManager.prototype, 'save').mockImplementation(async () => {
        saveStarted.resolve();
        await releaseSave.promise;
      });
      const bootstrap = vi.spyOn(workspace, 'bootstrap').mockResolvedValueOnce(0);

      const persisting = workspace.persist();
      await saveStarted.promise;
      const rebuilding = workspace.rebuild(fakeConnection);
      await flushPromises();
      expect(bootstrap).not.toHaveBeenCalled();

      releaseSave.resolve();
      await Promise.all([rebuilding, persisting]);
      expect(save).toHaveBeenCalledTimes(1);
      expect(bootstrap).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips queued reconfiguration after disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-disposed-queue-'));
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(fakeConnection);
      const rebuildGate = deferred<number>();
      vi.spyOn(workspace, 'bootstrap').mockReturnValueOnce(rebuildGate.promise);

      const rebuilding = workspace.rebuild(fakeConnection);
      const nextSettings = { ...DEFAULT_SETTINGS, debug: { definitionTrace: true } };
      const reconfiguring = workspace.reconfigure(fakeConnection, nextSettings);
      await flushPromises();
      workspace.dispose();
      rebuildGate.resolve(0);
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
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(fakeConnection);
      const first = deferred();
      const second = deferred();
      const bootstrap = vi.spyOn(workspace, 'bootstrap')
        .mockReturnValueOnce(first.promise.then(() => 0))
        .mockReturnValueOnce(second.promise.then(() => 0));

      const firstRebuild = workspace.rebuild(fakeConnection);
      await flushPromises();
      const secondRebuild = workspace.rebuild(fakeConnection);
      await flushPromises();

      expect(bootstrap).toHaveBeenCalledTimes(1);
      expect(workspace.indexStatus().lifecycle).toMatchObject({
        state: 'indexing',
        operation: 'rebuild',
      });

      first.resolve();
      await flushPromises(10);
      expect(bootstrap).toHaveBeenCalledTimes(2);
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
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(fakeConnection);
      const rebuilding = deferred();
      vi.spyOn(workspace, 'bootstrap').mockReturnValueOnce(rebuilding.promise.then(() => 0));

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
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(fakeConnection);
      vi.spyOn(workspace, 'bootstrap').mockRejectedValueOnce(new Error('rebuild infrastructure failed'));
      const applyChanges = vi.spyOn(workspace.index, 'applyChanges');

      const rebuild = workspace.rebuild(fakeConnection);
      const incremental = workspace.applyChanges(
        [{ uri: pathToFileURL(join(root, 'Changed.hlsl')).href, type: 'changed' }],
        fakeConnection,
      );

      await expect(rebuild).rejects.toThrow('rebuild infrastructure failed');
      await expect(incremental).resolves.toBeUndefined();
      expect(applyChanges).not.toHaveBeenCalled();
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'failed',
        failure: { category: 'indexing', message: 'rebuild infrastructure failed' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('indexes user files and Packages into the global index', async () => {
    const folder = pathToFileURL(projectA).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.bootstrap(fakeConnection);

    expect(workspace.isStandalone()).toBe(false);
    expect(workspace.index.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspace.index.global.lookup('Core').length).toBeGreaterThanOrEqual(1);
  });

  it('indexes user files and Packages into the global reference index', async () => {
    const projectRoot = projectA;
    const folder = pathToFileURL(projectRoot).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.bootstrap(fakeConnection);

    const refs = workspace.index.globalRefs.lookup('Core');
    expect(refs.some((ref) => ref.location.uri.endsWith('/Assets/Shaders/Main.shader'))).toBe(true);
  });

  it('writes cache on first bootstrap and restores it on the second bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cache-bootstrap-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'Assets', 'Shaders', 'Cached.hlsl'), 'float4 CachedSymbol() { return 0; }');

    try {
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws1.bootstrap(fakeConnection);

      const cachePath = join(root, 'Library', 'UnityShaderNavCache', 'index.json');
      const manifest = JSON.parse(await readFile(cachePath, 'utf8'));
      expect(manifest.files.length).toBeGreaterThanOrEqual(1);

      const fullScan = vi.spyOn(Workspace.prototype, 'fullScan');
      const restore = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.bootstrap(fakeConnection);

      expect(fullScan).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalled();
      expect(ws2.index.global.lookup('CachedSymbol').length).toBeGreaterThanOrEqual(1);
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
      await first.bootstrap(fakeConnection);

      const cachePath = join(root, 'Library', 'UnityShaderNavCache', 'index.json');
      const manifest = JSON.parse(await readFile(cachePath, 'utf8'));
      const persistedIdentity = manifest.fingerprint.indexImplementation as string;
      const staleIdentity = persistedIdentity === 'a'.repeat(64)
        ? 'b'.repeat(64)
        : 'a'.repeat(64);
      manifest.fingerprint.indexImplementation = staleIdentity;
      await writeFile(cachePath, JSON.stringify(manifest), 'utf8');

      const fullScan = vi.spyOn(Workspace.prototype, 'fullScan');
      const restore = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      const second = new Workspace(folderUri, DEFAULT_SETTINGS);
      await second.bootstrap(fakeConnection);

      expect(fullScan).toHaveBeenCalledTimes(1);
      expect(restore).not.toHaveBeenCalled();
      expect(second.index.global.lookup('CurrentImplementation')).toHaveLength(1);
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
      await workspace.bootstrap(connection);

      expect(workspace.index.global.lookup('SourceStillWorks')).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('cache disabled'));
      await expect(readFile(
        join(root, 'Library', 'UnityShaderNavCache', 'index.json'),
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
      await ws1.bootstrap(fakeConnection);

      const cachePath = join(root, 'Library', 'UnityShaderNavCache', 'index.json');
      const { files: _files, ...corruptedManifest } = JSON.parse(await readFile(cachePath, 'utf8'));
      await writeFile(cachePath, JSON.stringify(corruptedManifest), 'utf8');

      const fullScan = vi.spyOn(Workspace.prototype, 'fullScan');
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await workspace.bootstrap(fakeConnection);

      expect(fullScan).toHaveBeenCalledTimes(1);
      expect(workspace.index.global.lookup('RecoveredSymbol').length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists opened standalone files into global storage and restores them on next bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-standalone-cache-'));
    const globalStorageDir = await mkdtemp(join(tmpdir(), 'usn-global-storage-'));
    const shaderPath = join(root, 'Loose.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 StandaloneCached() { return 0; }');

    try {
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws1.initialize(fakeConnection, globalStorageDir);
      await ws1.index.reindex(shaderUri, await readFile(shaderPath, 'utf8'));
      await ws1.persist();

      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.bootstrap(fakeConnection, globalStorageDir);

      expect(ws2.isStandalone()).toBe(true);
      expect(ws2.index.global.lookup('StandaloneCached').length).toBeGreaterThanOrEqual(1);
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
      await ws1.index.reindex(shaderUri, 'float4 UnsavedOnly() { return 0; }');
      await ws1.persist();

      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.bootstrap(fakeConnection, globalStorageDir);

      expect(ws2.index.global.lookup('UnsavedOnly')).toEqual([]);
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
      await workspace.index.reindex(bUri, await readFile(bPath, 'utf8'));
      await workspace.index.reindex(aUri, await readFile(aPath, 'utf8'));
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
      await ws1.bootstrap(fakeConnection);
      expect(ws1.index.global.lookup('OldPackageSymbol').length).toBeGreaterThanOrEqual(1);

      await writeLockfile('newhash');
      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.bootstrap(fakeConnection);

      expect(ws2.index.global.lookup('OldPackageSymbol')).toEqual([]);
      expect(ws2.index.global.lookup('NewPackageSymbol').length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores the full-scan index when a scanned file is opened and closed', async () => {
    const projectRoot = projectA;
    const folder = pathToFileURL(projectRoot).href;
    const commonUri = pathToFileURL(join(projectRoot, 'Assets', 'Shaders', 'Common.hlsl')).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.bootstrap(fakeConnection);
    expect(workspace.index.global.lookup('Common').length).toBeGreaterThanOrEqual(1);

    await workspace.index.reindex(commonUri, 'float4 LiveOnly() { return 0; }');
    expect(workspace.index.global.lookup('Common')).toEqual([]);
    expect(workspace.index.global.lookup('LiveOnly').length).toBeGreaterThanOrEqual(1);

    workspace.index.closeDocument(commonUri);

    expect(workspace.index.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspace.index.global.lookup('LiveOnly')).toEqual([]);
  });

  it('keeps global references in sync with live reindex and drop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-refs-'));
    const shaderPath = join(root, 'Loose.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 SavedOnly() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await workspace.bootstrap(fakeConnection);

      await workspace.index.reindex(shaderUri, 'float4 Caller() { return Target(); }');
      expect(workspace.index.globalRefs.lookup('Target')).toHaveLength(1);

      await workspace.index.reindex(shaderUri, 'float4 Caller() { return 0; }');
      expect(workspace.index.globalRefs.lookup('Target')).toEqual([]);

      await workspace.index.reindex(shaderUri, 'float4 Caller() { return Target(); }');
      workspace.index.drop(shaderUri);
      expect(workspace.index.globalRefs.lookup('Target')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects references under package roots', async () => {
    const projectRoot = projectA;
    const workspace = new Workspace(pathToFileURL(projectRoot).href, DEFAULT_SETTINGS);
    await workspace.bootstrap(fakeConnection);

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

    await workspace.bootstrap(fakeConnection);

    expect(workspace.isStandalone()).toBe(false);
    expect(workspace.unityRoot).toBe(projectRoot);
    expect(workspace.index.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspace.index.global.lookup('Core').length).toBeGreaterThanOrEqual(1);
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
    expect(workspace.index.global.lookup('BeforeChange').length).toBeGreaterThanOrEqual(1);

    await writeFile(shaderPath, 'float4 AfterChange() { return 1; }');
    await workspace.applyChanges([{ uri: shaderUri, type: 'changed' }], fakeConnection);

    expect(workspace.index.global.lookup('BeforeChange')).toEqual([]);
    expect(workspace.index.global.lookup('AfterChange').length).toBeGreaterThanOrEqual(1);
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
    expect(workspace.index.global.lookup('DeletedSymbol').length).toBeGreaterThanOrEqual(1);

    await workspace.applyChanges([{ uri: shaderUri, type: 'deleted' }], fakeConnection);

    expect(workspace.index.store.get(shaderUri)).toBeUndefined();
    expect(workspace.index.global.lookup('DeletedSymbol')).toEqual([]);
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
    expect(workspace.index.global.lookup('BeforeRebuild').length).toBeGreaterThanOrEqual(1);

    await writeFile(shaderPath, 'float4 AfterRebuild() { return 1; }');
    await workspace.rebuild(fakeConnection);

    expect(workspace.index.global.lookup('BeforeRebuild')).toEqual([]);
    expect(workspace.index.global.lookup('AfterRebuild').length).toBeGreaterThanOrEqual(1);
    expect(workspace.packages.hasResolver()).toBe(true);
  });
});

describe('Workspace.reconfigure', () => {
  it('rebuilds the macro table and updates settings together when declarationMacros change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-reconfigure-macros-'));
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(fakeConnection);
      const before = workspace.index.table;
      expect(before.findDecl('MY_TEX')).toHaveLength(0);

      await workspace.reconfigure(fakeConnection, {
        ...DEFAULT_SETTINGS,
        declarationMacros: [{ pattern: 'MY_TEX($name)', kind: 'variable' }],
      });

      expect(workspace.settings.declarationMacros).toHaveLength(1);
      expect(workspace.index.table).not.toBe(before);
      expect(workspace.index.table.findDecl('MY_TEX')).toHaveLength(1);
      expect(workspace.indexStatus().lifecycle).toMatchObject({ state: 'ready', revision: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
