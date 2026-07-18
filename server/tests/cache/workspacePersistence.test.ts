import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SETTINGS,
  type CacheManifest,
} from '@unity-shader-nav/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseCacheDir } from '../../src/cache/cacheManager';
import { CacheStore } from '../../src/cache/cacheStore';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { Workspace } from '../../src/workspace/workspace';
import { WorkspaceIndex } from '../../src/workspace/workspaceIndex';

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

const releaseRuntime = { releaseVersion: '0.1.1' } as const;

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
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

function snapshot(uri: string, text: string): IndexedDocumentSnapshot {
  return { uri, text, version: 1, openId: 1, languageId: 'hlsl' };
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

function cacheDir(root: string, folderUri: string): string {
  const dir = chooseCacheDir({
    unityProjectRoot: root,
    workspaceFolderUri: folderUri,
    globalStorageDir: undefined,
  });
  if (!dir) throw new Error('Expected a Unity workspace cache directory');
  return dir;
}

async function loadManifest(root: string, folderUri: string): Promise<CacheManifest> {
  const raw = await readFile(join(cacheDir(root, folderUri), 'index.json'), 'utf8');
  return JSON.parse(raw) as CacheManifest;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Workspace cache persistence lifecycle', () => {
  it('restarts from the newest changed, created, and deleted disk projection after an older save blocks', async () => {
    const root = await createUnityProject('usn-cache-latest-workspace-');
    const folderUri = pathToFileURL(root).href;
    const targetPath = join(root, 'Assets', 'Shaders', 'Target.hlsl');
    const callerPath = join(root, 'Assets', 'Shaders', 'Caller.hlsl');
    const deletedPath = join(root, 'Assets', 'Shaders', 'Deleted.hlsl');
    const targetUri = pathToFileURL(targetPath).href;
    const callerUri = pathToFileURL(callerPath).href;
    const deletedUri = pathToFileURL(deletedPath).href;
    const staleTarget = 'float4 StaleTarget() { return 0; }';
    const latestTarget = 'float4 LatestTarget() { return 1; }';
    const latestCaller = [
      '#include "Target.hlsl"',
      'float4 LatestCaller() { return LatestTarget(); }',
    ].join('\n');
    await writeFile(targetPath, staleTarget);
    await writeFile(deletedPath, 'float4 DeletedTarget() { return 0; }');

    try {
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, releaseRuntime);
      await workspace.initialize(fakeConnection);
      expect(hasWorkspaceSymbol(workspace, 'StaleTarget')).toBe(true);
      expect(hasWorkspaceSymbol(workspace, 'DeletedTarget')).toBe(true);

      const saveStarted = deferred();
      const releaseSave = deferred();
      const originalSave = CacheStore.prototype.save;
      let saveCalls = 0;
      const save = vi.spyOn(CacheStore.prototype, 'save').mockImplementation(async function (
        manifest,
      ) {
        saveCalls++;
        if (saveCalls === 1) {
          saveStarted.resolve();
          await releaseSave.promise;
        }
        await originalSave.call(this, manifest);
      });

      const stalePersistence = workspace.persist();
      await saveStarted.promise;

      await writeFile(targetPath, latestTarget);
      await writeFile(callerPath, latestCaller);
      await unlink(deletedPath);
      const applyingLatest = workspace.applyChanges([
        { uri: targetUri, type: 'changed' },
        { uri: callerUri, type: 'created' },
        { uri: deletedUri, type: 'deleted' },
      ], fakeConnection);

      await vi.waitFor(() => {
        expect(hasWorkspaceSymbol(workspace, 'LatestTarget')).toBe(true);
        expect(hasWorkspaceSymbol(workspace, 'LatestCaller')).toBe(true);
        expect(hasWorkspaceSymbol(workspace, 'DeletedTarget')).toBe(false);
      });

      releaseSave.resolve();
      await Promise.all([stalePersistence, applyingLatest]);
      save.mockRestore();

      const manifest = await loadManifest(root, folderUri);
      const byUri = new Map(manifest.files.map((file) => [file.uri, file]));
      expect([...byUri.keys()]).toContain(targetUri);
      expect([...byUri.keys()]).toContain(callerUri);
      expect([...byUri.keys()]).not.toContain(deletedUri);
      expect(byUri.get(targetUri)?.index.symbols.some(
        (symbol) => symbol.name === 'LatestTarget',
      )).toBe(true);
      expect(byUri.get(targetUri)?.index.symbols.some(
        (symbol) => symbol.name === 'StaleTarget',
      )).toBe(false);
      expect(byUri.get(callerUri)?.index.references.some(
        (reference) => reference.name === 'LatestTarget' && reference.context === 'call',
      )).toBe(true);
      workspace.dispose();

      const indexAndStore = vi.spyOn(WorkspaceIndex.prototype, 'indexAndStore');
      const restoreFromCache = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      const restarted = new Workspace(folderUri, DEFAULT_SETTINGS, releaseRuntime);
      await restarted.initialize(fakeConnection);

      expect(indexAndStore).not.toHaveBeenCalled();
      expect(restoreFromCache).toHaveBeenCalled();
      expect(hasWorkspaceSymbol(restarted, 'LatestTarget')).toBe(true);
      expect(hasWorkspaceSymbol(restarted, 'LatestCaller')).toBe(true);
      expect(hasWorkspaceSymbol(restarted, 'StaleTarget')).toBe(false);
      expect(hasWorkspaceSymbol(restarted, 'DeletedTarget')).toBe(false);

      const references = await restarted.referencesAt({
        document: snapshot(targetUri, latestTarget),
        position: positionOf(latestTarget, 'LatestTarget'),
        includeDeclaration: false,
      });
      expect(references).toContainEqual(expect.objectContaining({ uri: callerUri }));
      restarted.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps the published revision ready and queryable when cache persistence fails', async () => {
    const root = await createUnityProject('usn-cache-failure-workspace-');
    const folderUri = pathToFileURL(root).href;
    const shaderPath = join(root, 'Assets', 'Shaders', 'Current.hlsl');
    const shaderUri = pathToFileURL(shaderPath).href;
    await writeFile(shaderPath, 'float4 BeforeFailure() { return 0; }');

    try {
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, releaseRuntime);
      await workspace.initialize(fakeConnection);
      vi.spyOn(CacheStore.prototype, 'save')
        .mockRejectedValueOnce(new Error('simulated cache write failure'));

      await writeFile(shaderPath, 'float4 AfterFailure() { return 1; }');
      await expect(workspace.applyChanges([
        { uri: shaderUri, type: 'changed' },
      ], fakeConnection)).resolves.toBeUndefined();

      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 0,
      });
      expect(workspace.canServe()).toBe(true);
      expect(hasWorkspaceSymbol(workspace, 'BeforeFailure')).toBe(false);
      expect(hasWorkspaceSymbol(workspace, 'AfterFailure')).toBe(true);
      workspace.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

});

describe('Unity cache workspace identity isolation', () => {
  it.each([
    ['parent then nested', ['parent', 'nested'] as const],
    ['nested then parent', ['nested', 'parent'] as const],
  ])('warm-restores both identities when saved %s', async (_label, order) => {
    const root = await createUnityProject('usn-cache-unity-identities-');
    const nested = join(root, 'Assets', 'Feature');
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(root, 'Assets', 'Shaders', 'Shared.hlsl'),
      'float4 SharedAcrossFolders() { return 0; }',
    );
    const parentUri = pathToFileURL(root).href;
    const nestedUri = pathToFileURL(nested).href;
    const folderUris = { parent: parentUri, nested: nestedUri };
    const original = new Map<'parent' | 'nested', Workspace>();

    try {
      for (const identity of order) {
        const workspace = new Workspace(
          folderUris[identity],
          DEFAULT_SETTINGS,
          releaseRuntime,
        );
        original.set(identity, workspace);
        await workspace.initialize(fakeConnection);
      }

      const parentCacheDir = cacheDir(root, parentUri);
      const nestedCacheDir = cacheDir(root, nestedUri);
      expect(parentCacheDir).not.toBe(nestedCacheDir);
      expect((await loadManifest(root, parentUri)).workspaceFolderUri).toBe(parentUri);
      expect((await loadManifest(root, nestedUri)).workspaceFolderUri).toBe(nestedUri);
      for (const workspace of original.values()) workspace.dispose();

      const restoreFromCache = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      const parentRestarted = new Workspace(parentUri, DEFAULT_SETTINGS, releaseRuntime);
      const nestedRestarted = new Workspace(nestedUri, DEFAULT_SETTINGS, releaseRuntime);
      await parentRestarted.initialize(fakeConnection);
      const parentRestoreCalls = restoreFromCache.mock.calls.length;
      await nestedRestarted.initialize(fakeConnection);

      expect(parentRestoreCalls).toBeGreaterThan(0);
      expect(restoreFromCache.mock.calls.length).toBeGreaterThan(parentRestoreCalls);
      expect(hasWorkspaceSymbol(parentRestarted, 'SharedAcrossFolders')).toBe(true);
      expect(hasWorkspaceSymbol(nestedRestarted, 'SharedAcrossFolders')).toBe(true);
      parentRestarted.dispose();
      nestedRestarted.dispose();
    } finally {
      for (const workspace of original.values()) workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('warm-restores across equivalent Windows drive-letter Workspace URIs', async () => {
    const root = await createUnityProject('usn-cache-windows-drive-identity-');
    const shaderPath = join(root, 'Assets', 'Shaders', 'WindowsIdentity.hlsl');
    const symbolName = 'RestoredAcrossDriveCase';
    await writeFile(shaderPath, `float4 ${symbolName}() { return 0; }`);
    const upperDriveUri = 'file:///C:/Unity/CanonicalWorkspace';
    const lowerDriveUri = 'file:///c:/Unity/CanonicalWorkspace';
    const settings = { ...DEFAULT_SETTINGS, projectRoot: root };
    let cold: Workspace | undefined;
    let warm: Workspace | undefined;

    try {
      expect(cacheDir(root, upperDriveUri)).toBe(cacheDir(root, lowerDriveUri));

      cold = new Workspace(upperDriveUri, settings, releaseRuntime);
      await cold.initialize(fakeConnection);
      expect(hasWorkspaceSymbol(cold, symbolName)).toBe(true);
      expect((await loadManifest(root, upperDriveUri)).workspaceFolderUri).toBe(upperDriveUri);
      cold.dispose();
      cold = undefined;

      const restoreFromCache = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      warm = new Workspace(lowerDriveUri, settings, releaseRuntime);
      await warm.initialize(fakeConnection);

      expect(restoreFromCache).toHaveBeenCalled();
      expect(hasWorkspaceSymbol(warm, symbolName)).toBe(true);
    } finally {
      cold?.dispose();
      warm?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('Unity cache package membership', () => {
  it('does not restore symbols or references from a removed external local package', async () => {
    const root = await createUnityProject('usn-cache-external-local-project-');
    const externalRoot = await mkdtemp(join(tmpdir(), 'usn-cache-external-local-package-'));
    const folderUri = pathToFileURL(root).href;
    const targetPath = join(root, 'Assets', 'Shaders', 'ProjectTarget.hlsl');
    const targetUri = pathToFileURL(targetPath).href;
    const packagePath = join(externalRoot, 'ExternalPackage.hlsl');
    const packageUri = pathToFileURL(packagePath).href;
    const targetSource = 'float4 ProjectTarget() { return 0; }';
    const targetInclude = relative(externalRoot, targetPath).replaceAll('\\', '/');
    const packageSource = [
      `#include "${targetInclude}"`,
      'float4 ExternalPackageSymbol() { return 0; }',
      'float4 ExternalPackageCaller() { return ProjectTarget(); }',
    ].join('\n');
    const lockPath = join(root, 'Packages', 'packages-lock.json');
    await writeFile(targetPath, targetSource);
    await writeFile(packagePath, packageSource);
    await writeFile(lockPath, JSON.stringify({
      dependencies: {
        'com.example.external': {
          version: `file:${externalRoot}`,
          source: 'local',
        },
      },
    }));

    try {
      const first = new Workspace(folderUri, DEFAULT_SETTINGS, releaseRuntime);
      await first.initialize(fakeConnection);
      expect((await first.documentSymbols({ uri: packageUri }))?.some(
        (symbol) => symbol.name === 'ExternalPackageSymbol',
      )).toBe(true);

      const initialManifest = await loadManifest(root, folderUri);
      const cachedPackage = initialManifest.files.find((file) => file.uri === packageUri);
      expect(cachedPackage?.index.symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ExternalPackageSymbol' }),
      ]));
      expect(cachedPackage?.index.references).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ProjectTarget', context: 'call' }),
      ]));
      first.dispose();

      await writeFile(lockPath, '{"dependencies":{}}');
      const restoreFromCache = vi.spyOn(WorkspaceIndex.prototype, 'restoreFromCache');
      const restarted = new Workspace(folderUri, DEFAULT_SETTINGS, releaseRuntime);
      await restarted.initialize(fakeConnection);

      expect(restoreFromCache).toHaveBeenCalled();
      const references = await restarted.referencesAt({
        document: snapshot(targetUri, targetSource),
        position: positionOf(targetSource, 'ProjectTarget'),
        includeDeclaration: false,
      });
      const externalSymbols = await restarted.documentSymbols({ uri: packageUri });
      expect({
        externalSymbolRestored: externalSymbols?.some(
          (symbol) => symbol.name === 'ExternalPackageSymbol',
        ) ?? false,
        externalReferenceRestored: references?.some((location) => location.uri === packageUri),
      }).toEqual({
        externalSymbolRestored: false,
        externalReferenceRestored: false,
      });
      restarted.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
