import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  applyScopedSettingsAndRebuild,
  applySettingsAndRebuild,
  openDocumentGenerationKey,
  rebuildWorkspacesWithOpenDocuments,
} from '../../src/lifecycle/rebuild';
import { Workspace, WorkspaceManager } from '../../src/workspace';
import {
  copyUnityProjectFixture,
  removeCopiedUnityProject,
} from '../helpers/copiedUnityProject';

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
      rebuildableList: async () => [workspace],
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
      rebuildableList: async () => [workspace],
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
      rebuildableList: async () => [workspace],
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
      rebuildableList: vi.fn(async () => {
        calls.push('rebuildableList');
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

    expect(calls).toEqual(['suspend', 'rebuildableList']);
    expect(workspace.rebuild).not.toHaveBeenCalled();
    expect(suspender.release).not.toHaveBeenCalled();

    ready.resolve();
    await rebuild;

    expect(calls).toEqual(['suspend', 'rebuildableList', 'ready', 'rebuild', 'release']);
  });

  it('starts rebuildable roots independently', async () => {
    const slow = deferred();
    const calls: string[] = [];
    const slowWorkspace = {
      folderUri: 'file:///slow',
      rebuild: vi.fn(async () => {
        calls.push('slow:start');
        await slow.promise;
        calls.push('slow:done');
      }),
    };
    const readyWorkspace = {
      folderUri: 'file:///ready',
      rebuild: vi.fn(async () => {
        calls.push('ready:done');
      }),
    };
    const manager = {
      rebuildableList: async () => [slowWorkspace, readyWorkspace],
      workspaceForOrCreateFile: vi.fn(),
    };

    const rebuilding = rebuildWorkspacesWithOpenDocuments(
      fakeConnection,
      manager as never,
      () => [],
    );
    await flushPromises();

    expect(calls).toEqual(['slow:start', 'ready:done']);
    slow.resolve();
    await rebuilding;
    expect(calls).toEqual(['slow:start', 'ready:done', 'slow:done']);
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
    const projectA = await copyUnityProjectFixture(resolve(__dirname, '../include/fixtures/projectA'));
    const projectB = await mkdtemp(join(tmpdir(), 'usn-scoped-settings-b-'));
    await mkdir(join(projectB, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(projectB, 'Packages'), { recursive: true });
    await mkdir(join(projectB, 'ProjectSettings'), { recursive: true });
    await writeFile(join(projectB, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(join(projectB, 'Assets', 'Shaders', 'OnlyInB.hlsl'), 'float4 OnlyInB() { return 0; }');

    try {
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
    } finally {
      await removeCopiedUnityProject(projectA);
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'findReferences.includePackages',
      nextSettings: {
        ...DEFAULT_SETTINGS,
        findReferences: { includePackages: true },
      },
      assertApplied: (settings: ExtensionSettings) => {
        expect(settings.findReferences.includePackages).toBe(true);
      },
    },
    {
      name: 'debug.definitionTrace',
      nextSettings: {
        ...DEFAULT_SETTINGS,
        debug: { definitionTrace: true },
      },
      assertApplied: (settings: ExtensionSettings) => {
        expect(settings.debug.definitionTrace).toBe(true);
      },
    },
  ])('applies a $name-only change without rebuilding indexes', async ({
    nextSettings,
    assertApplied,
  }) => {
    const workspace = {
      folderUri: 'file:///project-a',
      settings: DEFAULT_SETTINGS,
      index: { table: undefined as unknown },
      indexStatus: () => ({
        folderUri: 'file:///project-a',
        mode: 'unity' as const,
        lifecycle: { state: 'ready' as const, revision: 1, warningCount: 0 },
      }),
      rebuild: vi.fn(async () => {}),
      reconfigure(_connection: unknown, next: ExtensionSettings) {
        this.settings = next;
        return Promise.resolve(false);
      },
    };
    const manager = {
      list: () => [workspace],
      rebuildableList: async () => [workspace],
      workspaceForOrCreateFile: vi.fn(async () => ({
        index: { reindex: vi.fn(async () => {}) },
      })),
    };

    await applyScopedSettingsAndRebuild(
      fakeConnection,
      manager as never,
      async () => nextSettings,
      () => [{ uri: 'file:///project-a/Assets/Open.hlsl', version: 1, getText: () => 'float4 Open() { return 0; }' }],
    );

    assertApplied(workspace.settings);
    expect(workspace.rebuild).not.toHaveBeenCalled();
    expect(manager.workspaceForOrCreateFile).not.toHaveBeenCalled();
  });

  it('does not let an initially indexing root block settings on a ready root', async () => {
    const slow = deferred();
    const nextSettings = {
      ...DEFAULT_SETTINGS,
      debug: { definitionTrace: true },
    };
    const initialWorkspace = {
      folderUri: 'file:///initial',
      settings: DEFAULT_SETTINGS,
      indexStatus: () => ({
        folderUri: 'file:///initial',
        mode: 'unity' as const,
        lifecycle: { state: 'indexing' as const, operation: 'initial' as const },
      }),
      reconfigure: vi.fn(async () => {
        await slow.promise;
        return false;
      }),
    };
    const readyWorkspace = {
      folderUri: 'file:///ready',
      settings: DEFAULT_SETTINGS,
      indexStatus: () => ({
        folderUri: 'file:///ready',
        mode: 'unity' as const,
        lifecycle: { state: 'ready' as const, revision: 1, warningCount: 0 },
      }),
      reconfigure: vi.fn(async () => false),
    };
    const manager = {
      list: () => [initialWorkspace, readyWorkspace],
    };

    await applyScopedSettingsAndRebuild(
      fakeConnection,
      manager as never,
      async () => nextSettings,
      () => [],
    );

    expect(initialWorkspace.reconfigure).toHaveBeenCalledWith(fakeConnection, nextSettings);
    expect(readyWorkspace.reconfigure).toHaveBeenCalledWith(fakeConnection, nextSettings);
    slow.resolve();
  });

  it('decides queued S0 -> S1 -> S0 rebuilds from the settings active at execution time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-settings-reversal-'));
    try {
      const workspace = new Workspace(
        pathToFileURL(root).href,
        DEFAULT_SETTINGS,
        { ensureParserReady: async () => {}, indexImplementation: null },
      );
      const initial = deferred();
      const settingsSeenByBootstrap: ExtensionSettings[] = [];
      vi.spyOn(workspace, 'bootstrap').mockImplementation(async () => {
        if (settingsSeenByBootstrap.length === 0) await initial.promise;
        settingsSeenByBootstrap.push(workspace.settings);
        return 0;
      });
      const overlaySettings: ExtensionSettings[] = [];
      vi.spyOn(workspace.index, 'reindex').mockImplementation(async () => {
        overlaySettings.push(workspace.settings);
      });
      const manager = {
        list: () => [workspace],
        workspaceFor: () => workspace,
        workspaceForOrCreateFile: vi.fn(async () => workspace),
      };
      const settings1 = {
        ...DEFAULT_SETTINGS,
        excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, 'Assets/Hidden/**'],
      };

      const initializing = workspace.initialize(fakeConnection);
      await flushPromises();
      await applyScopedSettingsAndRebuild(
        fakeConnection,
        manager as never,
        async () => settings1,
        () => [{ uri: 'file:///Open.hlsl', version: 1, getText: () => 'unsaved' }],
      );
      await applyScopedSettingsAndRebuild(
        fakeConnection,
        manager as never,
        async () => DEFAULT_SETTINGS,
        () => [{ uri: 'file:///Open.hlsl', version: 1, getText: () => 'unsaved' }],
      );

      initial.resolve();
      await initializing;
      for (let i = 0; i < 50; i++) {
        const lifecycle = workspace.indexStatus().lifecycle;
        if (
          lifecycle.state === 'ready'
          && lifecycle.revision === 3
          && overlaySettings.length > 0
        ) break;
        await flushPromises();
      }

      expect(settingsSeenByBootstrap).toEqual([DEFAULT_SETTINGS, settings1, DEFAULT_SETTINGS]);
      expect(overlaySettings.at(-1)).toBe(DEFAULT_SETTINGS);
      expect(workspace.settings).toBe(DEFAULT_SETTINGS);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 3,
        warningCount: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
