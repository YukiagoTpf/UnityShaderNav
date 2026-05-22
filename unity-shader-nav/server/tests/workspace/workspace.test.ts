import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
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

describe('Workspace.bootstrap', () => {
  it('indexes user files and Packages into the global index', async () => {
    const folder = pathToFileURL(resolve(__dirname, '../include/fixtures/projectA')).href;
    const workspace = new Workspace(folder, DEFAULT_SETTINGS);

    await workspace.bootstrap(fakeConnection);

    expect(workspace.isStandalone()).toBe(false);
    expect(workspace.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspace.global.lookup('Core').length).toBeGreaterThanOrEqual(1);
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
});
