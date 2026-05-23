import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import { applySettingsAndRebuild, rebuildWorkspacesWithOpenDocuments } from '../../src/lifecycle/rebuild';
import { WorkspaceManager } from '../../src/workspace';

const fakeConnection = {
  console: { log() {} },
  sendNotification() {},
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

describe('rebuildWorkspacesWithOpenDocuments', () => {
  it('restores open document overlays before releasing suspended requests', async () => {
    const calls: string[] = [];
    const workspace = {
      rebuild: vi.fn(async () => {
        calls.push('rebuild');
      }),
    };
    const liveWorkspace = {
      reindex: vi.fn(async (_uri: string, text: string) => {
        calls.push(`reindex:${text}`);
      }),
    };
    const manager = {
      list: () => [workspace],
      workspaceForOrCreateFile: vi.fn(async () => liveWorkspace),
    };
    const suspender = {
      suspend: vi.fn(() => calls.push('suspend')),
      release: vi.fn(() => calls.push('release')),
    };

    await rebuildWorkspacesWithOpenDocuments(
      fakeConnection,
      manager as never,
      () => [{ uri: 'file:///Standalone.hlsl', getText: () => 'float4 LiveOnly() { return 0; }' }],
      suspender,
    );

    expect(calls).toEqual([
      'suspend',
      'rebuild',
      'reindex:float4 LiveOnly() { return 0; }',
      'release',
    ]);
  });

  it('settings rebuild clears symbols excluded by the new settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-settings-rebuild-'));
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(root, 'Assets', 'Shaders', 'Keep.hlsl'), 'float4 KeepSymbol() { return 0; }');
    await writeFile(join(root, 'Assets', 'Shaders', 'Stale.hlsl'), 'float4 StaleSymbol() { return 0; }');

    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, fakeConnection);
    const workspace = manager.list()[0];
    expect(workspace.global.lookup('KeepSymbol').length).toBeGreaterThanOrEqual(1);
    expect(workspace.global.lookup('StaleSymbol').length).toBeGreaterThanOrEqual(1);

    await applySettingsAndRebuild(
      fakeConnection,
      manager,
      {
        ...DEFAULT_SETTINGS,
        excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, 'Assets/Shaders/Stale.hlsl'],
      },
      () => [],
    );

    expect(workspace.global.lookup('KeepSymbol').length).toBeGreaterThanOrEqual(1);
    expect(workspace.global.lookup('StaleSymbol')).toEqual([]);
  });
});
