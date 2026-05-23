import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { WorkspaceManager } from '../../src/workspace/workspaceManager';
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

async function makeProjectB(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usn-project-b-'));
  await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
  await writeFile(join(root, 'Assets', 'Shaders', 'OnlyInB.hlsl'), 'float4 OnlyInB() { return 0; }');
  return root;
}

describe('WorkspaceManager: multi-root', () => {
  it('routes files to their owning workspace and keeps indexes isolated', async () => {
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
    const projectB = await makeProjectB();
    const projectAUri = pathToFileURL(projectA).href;
    const projectBUri = pathToFileURL(projectB).href;
    const manager = new WorkspaceManager();

    await manager.addFolder(projectAUri, DEFAULT_SETTINGS, fakeConnection);
    await manager.addFolder(projectBUri, DEFAULT_SETTINGS, fakeConnection);

    const workspaceA = manager.workspaceFor(pathToFileURL(join(projectA, 'Assets', 'Shaders', 'Common.hlsl')).href);
    const workspaceB = manager.workspaceFor(pathToFileURL(join(projectB, 'Assets', 'Shaders', 'OnlyInB.hlsl')).href);

    expect(workspaceA?.folderUri).toBe(projectAUri);
    expect(workspaceB?.folderUri).toBe(projectBUri);
    expect(workspaceA?.global.lookup('OnlyInB')).toEqual([]);
    expect(workspaceB?.global.lookup('Common')).toEqual([]);
  });

  it('reports ready when any workspace is a Unity project', async () => {
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
    const manager = new WorkspaceManager();

    expect(manager.mode()).toBe('standalone');
    await manager.addFolder(pathToFileURL(projectA).href, DEFAULT_SETTINGS, fakeConnection);

    expect(manager.mode()).toBe('ready');
  });

  it('uses the latest configured settings when adding a folder after configuration changes', async () => {
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-latest-settings-'));
    const manager = new WorkspaceManager();

    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    manager.configure({ ...DEFAULT_SETTINGS, projectRoot: projectA }, fakeConnection);
    await manager.addFolder(pathToFileURL(standaloneFolder).href, DEFAULT_SETTINGS, fakeConnection);

    const workspace = manager.list()[0];
    expect(workspace.unityRoot).toBe(projectA);
    expect(workspace.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
  });

  it('passes configured globalStorageDir to newly added workspaces', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-global-storage-'));
    const manager = new WorkspaceManager();
    const bootstrap = vi
      .spyOn(Workspace.prototype, 'bootstrap')
      .mockResolvedValue(undefined);

    manager.configure(DEFAULT_SETTINGS, fakeConnection, '/global-storage');
    await manager.addFolder(pathToFileURL(standaloneFolder).href, DEFAULT_SETTINGS, fakeConnection);

    expect(bootstrap).toHaveBeenCalledWith(fakeConnection, '/global-storage');
  });

  it('persists all managed workspaces', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-persist-all-'));
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockResolvedValue(undefined);
    const persist = vi.spyOn(Workspace.prototype, 'persist').mockResolvedValue(undefined);

    await manager.addFolder(pathToFileURL(standaloneFolder).href, DEFAULT_SETTINGS, fakeConnection);
    await manager.persistAll();

    expect(persist).toHaveBeenCalledTimes(1);
  });
});
