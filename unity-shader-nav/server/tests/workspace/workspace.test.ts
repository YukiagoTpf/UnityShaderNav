import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { Workspace } from '../../src/workspace/workspace';

const fakeConnection = {
  console: { log() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Workspace.bootstrap', () => {
  it('indexes user files and Packages into the global index', async () => {
    const folder = pathToFileURL(resolve(__dirname, '../include/fixtures/projectA')).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.bootstrap(fakeConnection);

    expect(workspace.isStandalone()).toBe(false);
    expect(workspace.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspace.global.lookup('Core').length).toBeGreaterThanOrEqual(1);
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
      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.bootstrap(fakeConnection);

      expect(fullScan).not.toHaveBeenCalled();
      expect(ws2.global.lookup('CachedSymbol').length).toBeGreaterThanOrEqual(1);
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
      await ws1.bootstrap(fakeConnection, globalStorageDir);
      await ws1.reindex(shaderUri, await readFile(shaderPath, 'utf8'));
      await ws1.persist();

      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.bootstrap(fakeConnection, globalStorageDir);

      expect(ws2.isStandalone()).toBe(true);
      expect(ws2.global.lookup('StandaloneCached').length).toBeGreaterThanOrEqual(1);
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
      expect(ws1.global.lookup('OldPackageSymbol').length).toBeGreaterThanOrEqual(1);

      await writeLockfile('newhash');
      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      await ws2.bootstrap(fakeConnection);

      expect(ws2.global.lookup('OldPackageSymbol')).toEqual([]);
      expect(ws2.global.lookup('NewPackageSymbol').length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores the full-scan index when a scanned file is opened and closed', async () => {
    const projectRoot = resolve(__dirname, '../include/fixtures/projectA');
    const folder = pathToFileURL(projectRoot).href;
    const commonUri = pathToFileURL(join(projectRoot, 'Assets', 'Shaders', 'Common.hlsl')).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.bootstrap(fakeConnection);
    expect(workspace.global.lookup('Common').length).toBeGreaterThanOrEqual(1);

    await workspace.reindex(commonUri, 'float4 LiveOnly() { return 0; }');
    expect(workspace.global.lookup('Common')).toEqual([]);
    expect(workspace.global.lookup('LiveOnly').length).toBeGreaterThanOrEqual(1);

    workspace.closeDocument(commonUri);

    expect(workspace.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspace.global.lookup('LiveOnly')).toEqual([]);
  });

  it('uses settings.projectRoot when the workspace folder is not a Unity root', async () => {
    const projectRoot = resolve(__dirname, '../include/fixtures/projectA');
    const folder = pathToFileURL(await mkdtemp(join(tmpdir(), 'usn-non-root-'))).href;
    const workspace = new Workspace(folder, {
      ...DEFAULT_SETTINGS,
      projectRoot,
    });

    await workspace.bootstrap(fakeConnection);

    expect(workspace.isStandalone()).toBe(false);
    expect(workspace.unityRoot).toBe(projectRoot);
    expect(workspace.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspace.global.lookup('Core').length).toBeGreaterThanOrEqual(1);
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
    await workspace.bootstrap(fakeConnection);
    expect(workspace.global.lookup('BeforeChange').length).toBeGreaterThanOrEqual(1);

    await writeFile(shaderPath, 'float4 AfterChange() { return 1; }');
    await workspace.applyChanges([{ uri: shaderUri, type: 'changed' }], fakeConnection);

    expect(workspace.global.lookup('BeforeChange')).toEqual([]);
    expect(workspace.global.lookup('AfterChange').length).toBeGreaterThanOrEqual(1);
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
    await workspace.bootstrap(fakeConnection);
    expect(workspace.global.lookup('DeletedSymbol').length).toBeGreaterThanOrEqual(1);

    await workspace.applyChanges([{ uri: shaderUri, type: 'deleted' }], fakeConnection);

    expect(workspace.store.get(shaderUri)).toBeUndefined();
    expect(workspace.global.lookup('DeletedSymbol')).toEqual([]);
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
    await workspace.bootstrap(fakeConnection);
    expect(workspace.global.lookup('BeforeRebuild').length).toBeGreaterThanOrEqual(1);

    await writeFile(shaderPath, 'float4 AfterRebuild() { return 1; }');
    await workspace.rebuild(fakeConnection);

    expect(workspace.global.lookup('BeforeRebuild')).toEqual([]);
    expect(workspace.global.lookup('AfterRebuild').length).toBeGreaterThanOrEqual(1);
    expect(workspace.packageResolver).toBeDefined();
  });
});
