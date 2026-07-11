import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { promises as nodeFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import { registerFileWatchers } from '../../src/lifecycle/fileWatcher';
import { indexFile } from '../../src/parser/hlsl';
import { Workspace, type FileEvent } from '../../src/workspace/workspace';
import { WorkspaceManager } from '../../src/workspace/workspaceManager';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';

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

async function createUnityProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
  return root;
}

async function hasDocumentSymbol(
  workspace: Workspace,
  uri: string,
  name: string,
): Promise<boolean> {
  const pending = [...(await workspace.documentSymbols({ uri }) ?? [])];
  while (pending.length > 0) {
    const symbol = pending.pop()!;
    if (symbol.name === name) return true;
    pending.push(...(symbol.children ?? []));
  }
  return false;
}

function snapshot(uri: string, text: string): IndexedDocumentSnapshot {
  return { uri, text, version: 1, openId: 1, languageId: 'hlsl' };
}

function positionOf(text: string, needle: string): { line: number; character: number } {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`Missing test token: ${needle}`);
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

describe('atomic indexed revision acceptance', () => {
  it('publishes file creation and deletion as complete revisions', async () => {
    const root = await createUnityProject('usn-create-delete-publication-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Lifecycle.hlsl');
    const sourceUri = pathToFileURL(sourcePath).href;

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
      });
      await workspace.initialize(connection);
      expect(workspace.indexStatus().lifecycle).toMatchObject({ revision: 1 });

      await writeFile(sourcePath, 'float4 CreatedSymbol() { return 0; }');
      await workspace.applyChanges([{ uri: sourceUri, type: 'created' }], connection);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 0,
      });
      expect(workspace.workspaceSymbols('CreatedSymbol')).toHaveLength(1);
      expect(await hasDocumentSymbol(workspace, sourceUri, 'CreatedSymbol')).toBe(true);

      await unlink(sourcePath);
      await workspace.applyChanges([{ uri: sourceUri, type: 'deleted' }], connection);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 3,
        warningCount: 0,
      });
      expect(workspace.workspaceSymbols('CreatedSymbol')).toEqual([]);
      expect(await workspace.documentSymbols({ uri: sourceUri })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes one watcher batch only after both changed files are indexed', async () => {
    const root = await createUnityProject('usn-watcher-atomic-publication-');
    const firstPath = join(root, 'Assets', 'Shaders', 'First.hlsl');
    const secondPath = join(root, 'Assets', 'Shaders', 'Second.hlsl');
    const firstUri = pathToFileURL(firstPath).href;
    const secondUri = pathToFileURL(secondPath).href;
    const secondCandidateStarted = deferred();
    const releaseSecondCandidate = deferred();
    let applying: Promise<void> | undefined;

    await writeFile(firstPath, 'float4 OldFirst() { return 0; }');
    await writeFile(secondPath, 'float4 OldSecond() { return 0; }');
    vi.useFakeTimers();
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
        async indexDocument(uri, text, table) {
          if (text.includes('NewSecond')) {
            secondCandidateStarted.resolve();
            await releaseSecondCandidate.promise;
          }
          return indexFile(uri, text, table);
        },
      });
      await workspace.initialize(connection);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 1,
        warningCount: 0,
      });

      let notification: ((event: FileEvent) => void) | undefined;
      let receivedBatch: FileEvent[] | undefined;
      const watcherConnection = {
        console: { log: vi.fn(), error: vi.fn() },
        onNotification: vi.fn((name: string, handler: (event: FileEvent) => void) => {
          expect(name).toBe('unityShaderNav/fileChange');
          notification = handler;
        }),
      };
      const owner = {
        applyChanges(events: FileEvent[], eventConnection: never): Promise<void> {
          receivedBatch = [...events];
          applying = workspace.applyChanges(events, eventConnection);
          return applying;
        },
      };
      const manager = {
        readyWorkspacesFor: vi.fn(() => [owner]),
      };
      registerFileWatchers(watcherConnection as never, manager as never);

      await writeFile(firstPath, 'float4 NewFirst() { return 0; }');
      await writeFile(secondPath, 'float4 NewSecond() { return 0; }');
      const events: FileEvent[] = [
        { uri: firstUri, type: 'changed' },
        { uri: secondUri, type: 'changed' },
      ];
      for (const event of events) notification?.(event);
      vi.advanceTimersByTime(501);
      await secondCandidateStarted.promise;

      expect(receivedBatch).toEqual(events);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 1,
        warningCount: 0,
      });
      expect(workspace.workspaceSymbols('OldFirst')).toHaveLength(1);
      expect(workspace.workspaceSymbols('OldSecond')).toHaveLength(1);
      expect(workspace.workspaceSymbols('NewFirst')).toEqual([]);
      expect(workspace.workspaceSymbols('NewSecond')).toEqual([]);

      releaseSecondCandidate.resolve();
      await applying;

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 0,
      });
      expect(workspace.workspaceSymbols('OldFirst')).toEqual([]);
      expect(workspace.workspaceSymbols('OldSecond')).toEqual([]);
      expect(workspace.workspaceSymbols('NewFirst')).toHaveLength(1);
      expect(workspace.workspaceSymbols('NewSecond')).toHaveLength(1);
    } finally {
      releaseSecondCandidate.resolve();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains last-known-good symbols for an unreadable changed source and clears its warning after recovery', async () => {
    const root = await createUnityProject('usn-source-warning-recovery-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Recoverable.hlsl');
    const sourceUri = pathToFileURL(sourcePath).href;
    await writeFile(sourcePath, 'float4 LastKnownGood() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
      });
      await workspace.initialize(connection);
      expect(workspace.workspaceSymbols('LastKnownGood')).toHaveLength(1);

      await unlink(sourcePath);
      await workspace.applyChanges([{ uri: sourceUri, type: 'changed' }], connection);

      expect(workspace.workspaceSymbols('LastKnownGood')).toHaveLength(1);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 1,
      });

      await writeFile(sourcePath, 'float4 RecoveredSource() { return 0; }');
      await workspace.applyChanges([{ uri: sourceUri, type: 'changed' }], connection);

      expect(workspace.workspaceSymbols('LastKnownGood')).toEqual([]);
      expect(workspace.workspaceSymbols('RecoveredSource')).toHaveLength(1);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 3,
        warningCount: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes package-manifest rebuilds with their package index as one revision', async () => {
    const root = await createUnityProject('usn-package-rebuild-publication-');
    const oldRoot = join(root, 'Packages', 'com.example.old');
    const newRoot = join(root, 'Packages', 'com.example.new');
    const oldPath = join(oldRoot, 'Old.hlsl');
    const newPath = join(newRoot, 'New.hlsl');
    const oldUri = pathToFileURL(oldPath).href;
    const newUri = pathToFileURL(newPath).href;
    const newPackageStarted = deferred();
    const releaseNewPackage = deferred();
    let gateNewPackage = false;
    const writeLockfile = (name: string) => writeFile(
      join(root, 'Packages', 'packages-lock.json'),
      JSON.stringify({
        dependencies: {
          [name]: { version: `file:${name}`, source: 'embedded' },
        },
      }),
    );

    await mkdir(oldRoot, { recursive: true });
    await mkdir(newRoot, { recursive: true });
    await writeFile(oldPath, 'float4 OldPackage() { return 0; }');
    await writeFile(newPath, 'float4 NewPackage() { return 0; }');
    await writeLockfile('com.example.old');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
        async indexDocument(uri, text, table) {
          if (gateNewPackage && uri === newUri) {
            newPackageStarted.resolve();
            await releaseNewPackage.promise;
          }
          return indexFile(uri, text, table);
        },
      });
      await workspace.initialize(connection);
      expect(await hasDocumentSymbol(workspace, oldUri, 'OldPackage')).toBe(true);
      expect(await hasDocumentSymbol(workspace, newUri, 'NewPackage')).toBe(false);

      gateNewPackage = true;
      await writeLockfile('com.example.new');
      const rebuilding = workspace.rebuild(connection);
      await newPackageStarted.promise;

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'indexing',
        operation: 'rebuild',
        servingRevision: 1,
      });
      expect(await hasDocumentSymbol(workspace, oldUri, 'OldPackage')).toBe(true);
      expect(await hasDocumentSymbol(workspace, newUri, 'NewPackage')).toBe(false);

      releaseNewPackage.resolve();
      await rebuilding;

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 0,
      });
      expect(await hasDocumentSymbol(workspace, oldUri, 'OldPackage')).toBe(false);
      expect(await hasDocumentSymbol(workspace, newUri, 'NewPackage')).toBe(true);
    } finally {
      releaseNewPackage.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an async include query on the revision captured before its first file-system await', async () => {
    const root = await createUnityProject('usn-async-query-revision-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Source.hlsl');
    const targetPath = join(root, 'Assets', 'Shaders', 'Target.hlsl');
    const sourceUri = pathToFileURL(sourcePath).href;
    const targetUri = pathToFileURL(targetPath).href;
    const sourceText = [
      '#include "Target.hlsl"',
      'float4 UseCaptured() { return CapturedTarget(); }',
    ].join('\n');
    const accessStarted = deferred();
    const releaseAccess = deferred();
    const originalAccess = nodeFs.access.bind(nodeFs);
    let gateAccess = false;

    await writeFile(sourcePath, sourceText);
    await writeFile(targetPath, 'float4 CapturedTarget() { return 0; }');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
      });
      await workspace.initialize(connection);
      const document = snapshot(sourceUri, sourceText);
      await workspace.updateDocument(document);

      vi.spyOn(nodeFs, 'access').mockImplementation(async (path, mode) => {
        if (gateAccess && String(path) === targetPath) {
          accessStarted.resolve();
          await releaseAccess.promise;
        }
        return originalAccess(path, mode);
      });
      gateAccess = true;
      const capturedQuery = workspace.definitionAt({
        document,
        position: positionOf(sourceText, 'CapturedTarget();'),
      });
      await accessStarted.promise;

      await writeFile(targetPath, 'float4 ReplacementTarget() { return 0; }');
      await workspace.applyChanges([{ uri: targetUri, type: 'changed' }], connection);
      expect(workspace.workspaceSymbols('CapturedTarget')).toEqual([]);
      expect(workspace.workspaceSymbols('ReplacementTarget')).toHaveLength(1);

      releaseAccess.resolve();
      const capturedResult = await capturedQuery;
      expect(capturedResult).toHaveLength(1);
      const capturedLocation = capturedResult![0];
      expect('targetUri' in capturedLocation ? capturedLocation.targetUri : capturedLocation.uri)
        .toBe(targetUri);

      await expect(workspace.definitionAt({
        document,
        position: positionOf(sourceText, 'CapturedTarget();'),
      })).resolves.toBeNull();
    } finally {
      releaseAccess.resolve();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('aggregates cross-root symbols from the serving tuple while one root rebuilds', async () => {
    const rootA = await createUnityProject('usn-root-tuple-a-');
    const rootB = await createUnityProject('usn-root-tuple-b-');
    const sourceA = join(rootA, 'Assets', 'Shaders', 'RootA.hlsl');
    const sourceB = join(rootB, 'Assets', 'Shaders', 'RootB.hlsl');
    const candidateStarted = deferred();
    const releaseCandidate = deferred();
    await writeFile(sourceA, 'float4 OldRootA() { return 0; }');
    await writeFile(sourceB, 'float4 StableRootB() { return 0; }');

    try {
      const manager = new WorkspaceManager();
      manager.configure(DEFAULT_SETTINGS, connection);
      await manager.addFolder(pathToFileURL(rootA).href, DEFAULT_SETTINGS, connection);
      await manager.addFolder(pathToFileURL(rootB).href, DEFAULT_SETTINGS, connection);
      const workspaceA = manager.workspaceFor(pathToFileURL(sourceA).href)!;
      const originalBootstrap = workspaceA.bootstrap.bind(workspaceA);
      vi.spyOn(workspaceA, 'bootstrap').mockImplementation(async (...args) => {
        candidateStarted.resolve();
        await releaseCandidate.promise;
        return originalBootstrap(...args);
      });

      await writeFile(sourceA, 'float4 NewAndLongerRootA() { return 0; }');
      await rm(join(rootA, 'Library', 'UnityShaderNavCache'), {
        recursive: true,
        force: true,
      });
      const rebuilding = workspaceA.rebuild(connection);
      await candidateStarted.promise;

      expect(manager.workspaceSymbols('Root').map((symbol) => symbol.name)).toEqual([
        'OldRootA',
        'StableRootB',
      ]);
      releaseCandidate.resolve();
      await rebuilding;

      expect(manager.workspaceSymbols('Root').map((symbol) => symbol.name)).toEqual([
        'NewAndLongerRootA',
        'StableRootB',
      ]);
    } finally {
      releaseCandidate.resolve();
      vi.restoreAllMocks();
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it('keeps the last published behavior queryable after rebuild infrastructure fails', async () => {
    const root = await createUnityProject('usn-rebuild-failure-serving-');
    const sourcePath = join(root, 'Assets', 'Shaders', 'Stable.hlsl');
    await writeFile(sourcePath, 'float4 StableBeforeFailure() { return 0; }');
    let parserReadinessAttempts = 0;

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        indexImplementation: null,
        async ensureParserReady() {
          parserReadinessAttempts++;
          if (parserReadinessAttempts === 2) throw new Error('parser engine unavailable');
        },
      });
      await workspace.initialize(connection);
      expect(workspace.workspaceSymbols('StableBeforeFailure')).toHaveLength(1);

      await expect(workspace.rebuild(connection)).rejects.toThrow('parser engine unavailable');

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'failed',
        servingRevision: 1,
        failure: {
          category: 'parser-initialization',
          message: 'Unable to initialize the shader parser: parser engine unavailable',
        },
      });
      expect(workspace.workspaceSymbols('StableBeforeFailure')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
