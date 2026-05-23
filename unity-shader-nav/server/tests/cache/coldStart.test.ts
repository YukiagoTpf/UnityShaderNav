import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
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

describe('cold start with cache', () => {
  it('second bootstrap restores a usable index from cache', async () => {
    const root = resolve(__dirname, '../include/fixtures/projectA');
    const cacheDir = resolve(root, 'Library/UnityShaderNavCache');
    await rm(cacheDir, { recursive: true, force: true });

    const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
    const coldStart = Date.now();
    await ws1.bootstrap(fakeConnection);
    const coldMs = Date.now() - coldStart;

    const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
    const warmStart = Date.now();
    await ws2.bootstrap(fakeConnection);
    const warmMs = Date.now() - warmStart;

    expect(ws2.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(warmMs).toBeLessThanOrEqual(coldMs + 100);

    await rm(cacheDir, { recursive: true, force: true });
  }, 60_000);
});
