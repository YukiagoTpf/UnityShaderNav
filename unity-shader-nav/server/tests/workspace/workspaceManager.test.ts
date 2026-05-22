import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { WorkspaceManager } from '../../src/workspace/workspaceManager';

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
});
