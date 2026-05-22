import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
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
});
