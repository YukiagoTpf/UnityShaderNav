import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  it('second initialization restores a usable index from cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cold-cache-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'Assets', 'Shaders', 'Common.hlsl'), 'float4 Common() { return 0; }');
    const libraryDir = resolve(root, 'Library');
    const cacheDir = resolve(libraryDir, 'UnityShaderNavCache');
    await rm(libraryDir, { recursive: true, force: true });

    try {
      const ws1 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      const coldStart = Date.now();
      await ws1.initialize(fakeConnection);
      const coldMs = Date.now() - coldStart;

      const ws2 = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS);
      const warmStart = Date.now();
      await ws2.initialize(fakeConnection);
      const warmMs = Date.now() - warmStart;

      expect(ws2.workspaceSymbols('Common').some((symbol) => symbol.name === 'Common')).toBe(true);
      expect(warmMs).toBeLessThanOrEqual(coldMs + 100);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
