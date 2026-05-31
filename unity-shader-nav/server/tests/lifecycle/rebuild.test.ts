import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  applyScopedSettingsAndRebuild,
  applySettingsAndRebuild,
  openDocumentGenerationKey,
  rebuildWorkspacesWithOpenDocuments,
} from '../../src/lifecycle/rebuild';
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushPromises(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('rebuildWorkspacesWithOpenDocuments', () => {
  it('restores open document overlays before releasing suspended requests', async () => {
    const calls: string[] = [];
    const workspace = {
      rebuild: vi.fn(async () => {
        calls.push('rebuild');
      }),
    };
    const liveWorkspace = {
      index: {
        reindex: vi.fn(async (_uri: string, text: string) => {
          calls.push(`reindex:${text}`);
        }),
      },
    };
    const manager = {
      list: () => [workspace],
      readyList: async () => [workspace],
      workspaceForOrCreateFile: vi.fn(async () => liveWorkspace),
    };
    const suspender = {
      suspend: vi.fn(() => calls.push('suspend')),
      release: vi.fn(() => calls.push('release')),
    };

    await rebuildWorkspacesWithOpenDocuments(
      fakeConnection,
      manager as never,
      () => [{ uri: 'file:///Standalone.hlsl', version: 1, getText: () => 'float4 LiveOnly() { return 0; }' }],
      suspender,
    );

    expect(calls).toEqual([
      'suspend',
      'rebuild',
      'reindex:float4 LiveOnly() { return 0; }',
      'release',
    ]);
  });

  it('does not restore a stale open document overlay when the live version changes during reindex', async () => {
    const calls: string[] = [];
    const workspace = {
      rebuild: vi.fn(async () => {
        calls.push('rebuild');
      }),
    };
    const liveDocument = {
      uri: 'file:///Standalone.hlsl',
      version: 1,
      getText: () => 'float4 Stale() { return 0; }',
    };
    const liveWorkspace = {
      index: {
        reindex: vi.fn(async (_uri: string, text: string, shouldStore?: () => boolean) => {
          calls.push(`reindex-start:${text}`);
          liveDocument.version = 2;
          if (shouldStore?.() ?? true) calls.push(`store:${text}`);
        }),
      },
    };
    const manager = {
      list: () => [workspace],
      readyList: async () => [workspace],
      workspaceForOrCreateFile: vi.fn(async () => liveWorkspace),
    };
    const suspender = {
      suspend: vi.fn(() => calls.push('suspend')),
      release: vi.fn(() => calls.push('release')),
    };

    await rebuildWorkspacesWithOpenDocuments(
      fakeConnection,
      manager as never,
      () => [liveDocument],
      suspender,
    );

    expect(calls).toEqual([
      'suspend',
      'rebuild',
      'reindex-start:float4 Stale() { return 0; }',
      'release',
    ]);
  });

  it('does not restore a stale open document overlay after close and reopen at the same version', async () => {
    const calls: string[] = [];
    const workspace = {
      rebuild: vi.fn(async () => {
        calls.push('rebuild');
      }),
    };
    const staleDocument = {
      uri: 'file:///Standalone.hlsl',
      version: 1,
      [openDocumentGenerationKey]: 1,
      getText: () => 'float4 Stale() { return 0; }',
    };
    const freshDocument = {
      uri: 'file:///Standalone.hlsl',
      version: 1,
      [openDocumentGenerationKey]: 2,
      getText: () => 'float4 Fresh() { return 0; }',
    };
    let liveDocuments = [staleDocument];
    const liveWorkspace = {
      index: {
        reindex: vi.fn(async (_uri: string, text: string, shouldStore?: () => boolean) => {
          calls.push(`reindex-start:${text}`);
          liveDocuments = [freshDocument];
          if (shouldStore?.() ?? true) calls.push(`store:${text}`);
        }),
      },
    };
    const manager = {
      list: () => [workspace],
      readyList: async () => [workspace],
      workspaceForOrCreateFile: vi.fn(async () => liveWorkspace),
    };
    const suspender = {
      suspend: vi.fn(() => calls.push('suspend')),
      release: vi.fn(() => calls.push('release')),
    };

    await rebuildWorkspacesWithOpenDocuments(
      fakeConnection,
      manager as never,
      () => liveDocuments,
      suspender,
    );

    expect(calls).toEqual([
      'suspend',
      'rebuild',
      'reindex-start:float4 Stale() { return 0; }',
      'release',
    ]);
  });

  it('waits for ready workspaces before rebuilding', async () => {
    const calls: string[] = [];
    const ready = deferred();
    const workspace = {
      rebuild: vi.fn(async () => {
        calls.push('rebuild');
      }),
    };
    const manager = {
      list: () => [workspace],
      readyList: vi.fn(async () => {
        calls.push('readyList');
        await ready.promise;
        calls.push('ready');
        return [workspace];
      }),
      workspaceForOrCreateFile: vi.fn(async () => ({
        index: { reindex: vi.fn(async () => {}) },
      })),
    };
    const suspender = {
      suspend: vi.fn(() => calls.push('suspend')),
      release: vi.fn(() => calls.push('release')),
    };

    const rebuild = rebuildWorkspacesWithOpenDocuments(
      fakeConnection,
      manager as never,
      () => [],
      suspender,
    );
    await flushPromises();

    expect(calls).toEqual(['suspend', 'readyList']);
    expect(workspace.rebuild).not.toHaveBeenCalled();
    expect(suspender.release).not.toHaveBeenCalled();

    ready.resolve();
    await rebuild;

    expect(calls).toEqual(['suspend', 'readyList', 'ready', 'rebuild', 'release']);
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
    expect(workspace.index.global.lookup('KeepSymbol').length).toBeGreaterThanOrEqual(1);
    expect(workspace.index.global.lookup('StaleSymbol').length).toBeGreaterThanOrEqual(1);

    await applySettingsAndRebuild(
      fakeConnection,
      manager,
      {
        ...DEFAULT_SETTINGS,
        excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, 'Assets/Shaders/Stale.hlsl'],
      },
      () => [],
    );

    expect(workspace.index.global.lookup('KeepSymbol').length).toBeGreaterThanOrEqual(1);
    expect(workspace.index.global.lookup('StaleSymbol')).toEqual([]);
  });

  it('settings rebuild can apply folder-scoped projectRoot without polluting other roots', async () => {
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
    const projectB = await mkdtemp(join(tmpdir(), 'usn-scoped-settings-b-'));
    await mkdir(join(projectB, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(projectB, 'Packages'), { recursive: true });
    await mkdir(join(projectB, 'ProjectSettings'), { recursive: true });
    await writeFile(join(projectB, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(projectB, 'Assets', 'Shaders', 'OnlyInB.hlsl'), 'float4 OnlyInB() { return 0; }');

    const projectAUri = pathToFileURL(projectA).href;
    const projectBUri = pathToFileURL(projectB).href;
    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    await manager.addFolder(projectAUri, DEFAULT_SETTINGS, fakeConnection);
    await manager.addFolder(projectBUri, DEFAULT_SETTINGS, fakeConnection);

    await applyScopedSettingsAndRebuild(
      fakeConnection,
      manager,
      async (folderUri) => folderUri === projectAUri
        ? { ...DEFAULT_SETTINGS, projectRoot: projectA }
        : DEFAULT_SETTINGS,
      () => [],
    );

    const workspaceA = manager.workspaceFor(pathToFileURL(join(projectA, 'Assets', 'Shaders', 'Common.hlsl')).href);
    const workspaceB = manager.workspaceFor(pathToFileURL(join(projectB, 'Assets', 'Shaders', 'OnlyInB.hlsl')).href);

    expect(workspaceA?.index.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
    expect(workspaceB?.index.global.lookup('OnlyInB').length).toBeGreaterThanOrEqual(1);
    expect(workspaceB?.index.global.lookup('Common')).toEqual([]);
  });

  it('does not rebuild indexes when only findReferences.includePackages changes', async () => {
    const workspace = {
      folderUri: 'file:///project-a',
      settings: DEFAULT_SETTINGS,
      index: { table: undefined as unknown },
      rebuild: vi.fn(async () => {}),
    };
    const manager = {
      list: () => [workspace],
      readyList: async () => [workspace],
      workspaceForOrCreateFile: vi.fn(async () => ({
        index: { reindex: vi.fn(async () => {}) },
      })),
    };

    await applyScopedSettingsAndRebuild(
      fakeConnection,
      manager as never,
      async () => ({
        ...DEFAULT_SETTINGS,
        findReferences: { includePackages: true },
      }),
      () => [{ uri: 'file:///project-a/Assets/Open.hlsl', version: 1, getText: () => 'float4 Open() { return 0; }' }],
    );

    expect(workspace.settings.findReferences.includePackages).toBe(true);
    expect(workspace.rebuild).not.toHaveBeenCalled();
    expect(manager.workspaceForOrCreateFile).not.toHaveBeenCalled();
  });
});
