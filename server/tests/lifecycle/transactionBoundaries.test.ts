import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { promises as nodeFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import { registerFileWatchers } from '../../src/lifecycle/fileWatcher';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { Workspace, type FileEvent } from '../../src/workspace/workspace';

const connection = {
  console: { log() {}, warn() {}, error() {} },
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

function snapshot(
  uri: string,
  text: string,
  openId: number,
  version: number,
): IndexedDocumentSnapshot {
  return { uri, text, openId, version, languageId: 'hlsl' };
}

function observesError(operation: Promise<unknown>): Promise<Error | undefined> {
  return operation.then(
    () => undefined,
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  );
}

function hasSymbol(workspace: Workspace, name: string): boolean {
  return workspace.workspaceSymbols(name).some((symbol) => symbol.name === name);
}

async function createUnityProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
  return root;
}

describe('indexed revision transaction boundaries', () => {
  it('does not resurrect an excluded file from a watcher event queued behind settings rebuild', async () => {
    const root = await createUnityProject('usn-queued-watcher-scope-');
    const keepPath = join(root, 'Assets', 'Shaders', 'Keep.hlsl');
    const excludedPath = join(root, 'Assets', 'Shaders', 'Excluded.hlsl');
    const keepUri = pathToFileURL(keepPath).href;
    const excludedUri = pathToFileURL(excludedPath).href;
    const rebuildParseStarted = deferred();
    const releaseRebuildParse = deferred();
    let gateRebuild = false;
    let watcherApply: Promise<void> | undefined;

    await writeFile(keepPath, 'float4 KeepGate() { return 0; }');
    await writeFile(excludedPath, 'float4 OldExcluded() { return 0; }');
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
        async indexDocument(uri, text, table) {
          if (gateRebuild && uri === keepUri) {
            rebuildParseStarted.resolve();
            await releaseRebuildParse.promise;
          }
          return indexFile(uri, text, table);
        },
      });
      await workspace.initialize(connection);
      expect(hasSymbol(workspace, 'OldExcluded')).toBe(true);

      gateRebuild = true;
      const nextSettings = {
        ...DEFAULT_SETTINGS,
        excludePatterns: [
          ...DEFAULT_SETTINGS.excludePatterns,
          'Assets/Shaders/Excluded.hlsl',
        ],
      };
      const reconfiguring = workspace.reconfigure(connection, nextSettings);
      await rebuildParseStarted.promise;

      let notification: ((event: FileEvent) => void) | undefined;
      const watcherConnection = {
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        onNotification: vi.fn((_name: string, handler: (event: FileEvent) => void) => {
          notification = handler;
        }),
      };
      const owner = {
        applyChanges(events: FileEvent[], eventConnection: never): Promise<void> {
          watcherApply = workspace.applyChanges(events, eventConnection);
          return watcherApply;
        },
      };
      const manager = {
        readyWorkspacesFor: vi.fn((uri: string) => {
          expect(uri).toBe(excludedUri);
          expect(workspace.containsIndexedUri(uri)).toBe(true);
          return [owner];
        }),
      };
      registerFileWatchers(watcherConnection as never, manager as never);

      await writeFile(excludedPath, 'float4 MustNotResurrect() { return 0; }');
      vi.useFakeTimers();
      notification?.({ uri: excludedUri, type: 'changed' });
      vi.advanceTimersByTime(501);
      expect(watcherApply).toBeDefined();

      releaseRebuildParse.resolve();
      await reconfiguring;
      await watcherApply;

      expect(workspace.settings.excludePatterns).toContain('Assets/Shaders/Excluded.hlsl');
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 0,
      });
      expect(workspace.containsIndexedUri(excludedUri)).toBe(false);
      expect(hasSymbol(workspace, 'OldExcluded')).toBe(false);
      expect(hasSymbol(workspace, 'MustNotResurrect')).toBe(false);
    } finally {
      releaseRebuildParse.resolve();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a queued no-argument rebuild from settings active at execution time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-queued-rebuild-settings-'));
    const uri = pathToFileURL(join(root, 'Queued.hlsl')).href;
    const firstParseStarted = deferred();
    const releaseFirstParse = deferred();
    const tableStates: boolean[] = [];
    let firstParse = true;
    const text = [
      'float4 BlockQueue() { return 0; }',
      'QUEUED_DECL(ConfiguredSymbol)',
    ].join('\n');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
        async indexDocument(indexUri, source, table) {
          tableStates.push(table.findDecl('QUEUED_DECL').length > 0);
          if (firstParse) {
            firstParse = false;
            firstParseStarted.resolve();
            await releaseFirstParse.promise;
          }
          return indexFile(indexUri, source, table);
        },
      });
      await workspace.initialize(connection);

      const blocking = workspace.updateDocument(snapshot(uri, text, 1, 1));
      await firstParseStarted.promise;
      const settings1 = {
        ...DEFAULT_SETTINGS,
        declarationMacros: [{
          pattern: 'QUEUED_DECL($name)',
          kind: 'variable' as const,
        }],
      };
      const reconfiguring = workspace.reconfigure(connection, settings1);
      const rebuilding = workspace.rebuild(connection);

      releaseFirstParse.resolve();
      await Promise.all([blocking, reconfiguring, rebuilding]);

      expect(tableStates).toEqual([false, true, true]);
      expect(workspace.settings.declarationMacros).toEqual(settings1.declarationMacros);
      expect(hasSymbol(workspace, 'ConfiguredSymbol')).toBe(true);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 4,
        warningCount: 0,
      });
    } finally {
      releaseFirstParse.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects the same openId after close while accepting a later open session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-close-tombstone-'));
    const uri = pathToFileURL(join(root, 'Session.hlsl')).href;
    const stale = snapshot(uri, 'float4 ClosedSession() { return 0; }', 1, 1);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(connection);
      await expect(workspace.updateDocument(stale)).resolves.toBe(true);
      await workspace.closeDocument({ uri, openId: 1 });
      expect(workspace.indexStatus().lifecycle).toMatchObject({ revision: 3 });

      await expect(workspace.updateDocument(stale)).resolves.toBe(false);
      expect(workspace.indexStatus().lifecycle).toMatchObject({ revision: 3 });
      expect(hasSymbol(workspace, 'ClosedSession')).toBe(false);

      const reopened = snapshot(uri, 'float4 ReopenedSession() { return 0; }', 2, 1);
      await expect(workspace.updateDocument(reopened)).resolves.toBe(true);
      expect(hasSymbol(workspace, 'ReopenedSession')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves a close through failed rebuild replay and publishes it on the retained revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-rebuild-close-finalize-'));
    const firstUri = pathToFileURL(join(root, 'First.hlsl')).href;
    const secondUri = pathToFileURL(join(root, 'Second.hlsl')).href;
    const first = snapshot(firstUri, 'float4 FirstLive() { return 0; }', 1, 1);
    const second = snapshot(secondUri, 'float4 SecondLive() { return 0; }', 2, 1);
    const brokenSecond = snapshot(secondUri, 'float4 BrokenSecond() { return 0; }', 2, 2);
    const rebuildPreflightStarted = deferred();
    const releaseRebuildPreflight = deferred();
    let parserReadinessAttempts = 0;
    let openDocuments: IndexedDocumentSnapshot[] = [first, second];

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
        openDocuments: () => openDocuments,
        async ensureParserReady() {
          parserReadinessAttempts++;
          if (parserReadinessAttempts === 2) {
            rebuildPreflightStarted.resolve();
            await releaseRebuildPreflight.promise;
          }
        },
        async indexDocument(uri, text, table) {
          if (text.includes('BrokenSecond')) throw new Error('broken replay document');
          return indexFile(uri, text, table);
        },
      });
      await workspace.initialize(connection);
      expect(hasSymbol(workspace, 'FirstLive')).toBe(true);
      expect(hasSymbol(workspace, 'SecondLive')).toBe(true);

      const rebuildError = observesError(workspace.rebuild(connection));
      await rebuildPreflightStarted.promise;
      openDocuments = [brokenSecond];
      const closing = workspace.closeDocument({ uri: firstUri, openId: 1 });
      const brokenUpdateError = observesError(workspace.updateDocument(brokenSecond));
      releaseRebuildPreflight.resolve();

      expect((await rebuildError)?.message).toBe('broken replay document');
      await closing;
      expect((await brokenUpdateError)?.message).toBe('broken replay document');

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'failed',
        servingRevision: 2,
        failure: { category: 'indexing', message: 'broken replay document' },
      });
      expect(hasSymbol(workspace, 'FirstLive')).toBe(false);
      expect(hasSymbol(workspace, 'SecondLive')).toBe(true);
      expect(hasSymbol(workspace, 'BrokenSecond')).toBe(false);
    } finally {
      releaseRebuildPreflight.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops excluded and unlisted Unity live overlays on close instead of creating disk baselines', async () => {
    const root = await createUnityProject('usn-close-configured-scope-');
    const excludedPath = join(root, 'Library', 'Generated.hlsl');
    const unlistedPath = join(root, 'Packages', 'Unlisted', 'Hidden.hlsl');
    const excludedUri = pathToFileURL(excludedPath).href;
    const unlistedUri = pathToFileURL(unlistedPath).href;
    await mkdir(join(root, 'Library'), { recursive: true });
    await mkdir(join(root, 'Packages', 'Unlisted'), { recursive: true });
    await writeFile(excludedPath, 'float4 ExcludedDisk() { return 0; }');
    await writeFile(unlistedPath, 'float4 UnlistedDisk() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
      });
      await workspace.initialize(connection);
      expect(workspace.containsIndexedUri(excludedUri)).toBe(false);
      expect(workspace.containsIndexedUri(unlistedUri)).toBe(false);

      const cases = [
        {
          uri: excludedUri,
          openId: 1,
          liveName: 'ExcludedLive',
          diskName: 'ExcludedDisk',
        },
        {
          uri: unlistedUri,
          openId: 2,
          liveName: 'UnlistedLive',
          diskName: 'UnlistedDisk',
        },
      ];
      for (const entry of cases) {
        await workspace.updateDocument(snapshot(
          entry.uri,
          `float4 ${entry.liveName}() { return 0; }`,
          entry.openId,
          1,
        ));
        expect(hasSymbol(workspace, entry.liveName)).toBe(true);

        await workspace.closeDocument({ uri: entry.uri, openId: entry.openId });
        expect(hasSymbol(workspace, entry.liveName)).toBe(false);
        expect(hasSymbol(workspace, entry.diskName)).toBe(false);
        expect(workspace.containsIndexedUri(entry.uri)).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists retained records with their original source identity and reparses changed disk on restart', async () => {
    const root = await createUnityProject('usn-retained-cache-identity-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Cached.hlsl');
    const sourceUri = pathToFileURL(sourcePath).href;
    const cachePath = join(root, 'Library', 'UnityShaderNavCache', 'index.json');
    await writeFile(sourcePath, 'float4 CachedOld() { return 0; }');

    type CacheRecord = { uri: string; mtimeMs: number; size: number };
    const cacheRecord = async (): Promise<CacheRecord> => {
      const manifest = JSON.parse(await readFile(cachePath, 'utf8')) as {
        files: CacheRecord[];
      };
      const record = manifest.files.find((file) => file.uri === sourceUri);
      if (!record) throw new Error(`missing cache record for ${sourceUri}`);
      return record;
    };

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await workspace.initialize(connection);
      const originalIdentity = await cacheRecord();
      expect(hasSymbol(workspace, 'CachedOld')).toBe(true);

      await writeFile(
        sourcePath,
        'float4 CachedReplacementWithLongName() { return 0; }',
      );
      const changedIdentity = await stat(sourcePath);
      expect(changedIdentity.size).not.toBe(originalIdentity.size);
      const readFailure = vi.spyOn(nodeFs, 'readFile').mockRejectedValueOnce(
        Object.assign(new Error('source temporarily unreadable'), { code: 'EACCES' }),
      );

      await workspace.applyChanges([{ uri: sourceUri, type: 'changed' }], connection);
      readFailure.mockRestore();
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 1,
      });
      expect(hasSymbol(workspace, 'CachedOld')).toBe(true);
      const retainedIdentity = await cacheRecord();
      expect(retainedIdentity).toMatchObject({
        mtimeMs: originalIdentity.mtimeMs,
        size: originalIdentity.size,
      });
      expect(retainedIdentity.size).not.toBe(changedIdentity.size);

      workspace.dispose();
      const restored = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await restored.initialize(connection);
      expect(hasSymbol(restored, 'CachedOld')).toBe(false);
      expect(hasSymbol(restored, 'CachedReplacementWithLongName')).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not publish repeated nonexistent deletes or an unchanged unreadable warning', async () => {
    const root = await createUnityProject('usn-watcher-noop-revision-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Stable.hlsl');
    const sourceUri = pathToFileURL(sourcePath).href;
    const missingUri = pathToFileURL(
      join(root, 'Assets', 'Shaders', 'NeverExisted.hlsl'),
    ).href;
    await writeFile(sourcePath, 'float4 StableNoop() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
      });
      await workspace.initialize(connection);

      await workspace.applyChanges([{ uri: missingUri, type: 'deleted' }], connection);
      await workspace.applyChanges([{ uri: missingUri, type: 'deleted' }], connection);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 1,
        warningCount: 0,
      });

      await unlink(sourcePath);
      await workspace.applyChanges([{ uri: sourceUri, type: 'changed' }], connection);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 1,
      });
      await workspace.applyChanges([{ uri: sourceUri, type: 'changed' }], connection);

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 1,
      });
      expect(hasSymbol(workspace, 'StableNoop')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the last published revision when package metadata becomes invalid', async () => {
    const root = await createUnityProject('usn-invalid-package-retained-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Stable.hlsl');
    await writeFile(sourcePath, 'float4 StableAcrossPackageFailure() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
      });
      await workspace.initialize(connection);
      await writeFile(join(root, 'Packages', 'packages-lock.json'), '{invalid');

      await expect(workspace.rebuild(connection)).rejects.toThrow(
        /Invalid Packages\/packages-lock\.json/,
      );

      expect(workspace.indexStatus().lifecycle).toMatchObject({
        state: 'failed',
        servingRevision: 1,
        failure: { category: 'package-resolution' },
      });
      expect(hasSymbol(workspace, 'StableAcrossPackageFailure')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes compatible live edit and close revisions while preserving failed status', async () => {
    const root = await createUnityProject('usn-failed-live-publication-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Live.hlsl');
    const sourceUri = pathToFileURL(sourcePath).href;
    const beforeFailure = snapshot(
      sourceUri,
      'float4 BeforeFailureLive() { return 0; }',
      1,
      1,
    );
    const afterFailure = snapshot(
      sourceUri,
      'float4 AfterFailureLive() { return 0; }',
      1,
      2,
    );
    await writeFile(sourcePath, 'float4 SavedAfterFailedClose() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
      });
      await workspace.initialize(connection);
      await workspace.updateDocument(beforeFailure);
      await writeFile(join(root, 'Packages', 'packages-lock.json'), '{invalid');
      await expect(workspace.rebuild(connection)).rejects.toThrow(
        /Invalid Packages\/packages-lock\.json/,
      );
      expect(workspace.indexStatus().lifecycle).toMatchObject({
        state: 'failed',
        servingRevision: 2,
        failure: { category: 'package-resolution' },
      });

      await expect(workspace.updateDocument(afterFailure)).resolves.toBe(true);
      expect(workspace.indexStatus().lifecycle).toMatchObject({
        state: 'failed',
        servingRevision: 3,
        failure: { category: 'package-resolution' },
      });
      expect(hasSymbol(workspace, 'BeforeFailureLive')).toBe(false);
      expect(hasSymbol(workspace, 'AfterFailureLive')).toBe(true);

      await workspace.closeDocument({ uri: sourceUri, openId: 1 });
      expect(workspace.indexStatus().lifecycle).toMatchObject({
        state: 'failed',
        servingRevision: 4,
        failure: { category: 'package-resolution' },
      });
      expect(hasSymbol(workspace, 'AfterFailureLive')).toBe(false);
      expect(hasSymbol(workspace, 'SavedAfterFailedClose')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
