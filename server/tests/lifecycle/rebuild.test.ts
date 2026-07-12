import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  applyScopedSettingsAndRebuild,
  rebuildWorkspaces,
} from '../../src/lifecycle/rebuild';
import { indexFile } from '../../src/parser/hlsl';
import { Workspace, WorkspaceManager } from '../../src/workspace';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import {
  copyUnityProjectFixture,
  removeCopiedUnityProject,
} from '../helpers/copiedUnityProject';

const fakeConnection = {
  console: { log() {}, warn() {}, error() {} },
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

function openDocument(
  text: string,
  openId = 1,
  version = 1,
  uri = 'file:///Standalone.hlsl',
): IndexedDocumentSnapshot {
  return { uri, languageId: 'hlsl', text, openId, version };
}

describe('rebuildWorkspaces', () => {
  it('serves the retained published revision while replaying open documents into a rebuild candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-rebuild-serving-revision-'));
    const uri = pathToFileURL(join(root, 'Open.hlsl')).href;
    const candidateStarted = deferred();
    const releaseCandidate = deferred();
    let current = openDocument('float4 BeforeRebuild() { return 0; }', 1, 1, uri);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        indexImplementation: null,
        openDocuments: () => [current],
        async indexDocument(indexUri, text, table) {
          if (text.includes('AfterRebuild')) {
            candidateStarted.resolve();
            await releaseCandidate.promise;
          }
          return indexFile(indexUri, text, table);
        },
      });
      await workspace.initialize(fakeConnection);
      expect(workspace.workspaceSymbols('BeforeRebuild')).toHaveLength(1);

      current = openDocument('float4 AfterRebuild() { return 0; }', 1, 2, uri);
      const manager = {
        rebuildableList: async () => [workspace],
        workspaceForOrCreateFile: vi.fn(),
      };
      const rebuilding = rebuildWorkspaces(fakeConnection, manager as never);

      await candidateStarted.promise;
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'indexing',
        operation: 'rebuild',
        servingRevision: 1,
      });
      expect(workspace.workspaceSymbols('BeforeRebuild')).toHaveLength(1);
      expect(workspace.workspaceSymbols('AfterRebuild')).toEqual([]);
      expect(manager.workspaceForOrCreateFile).not.toHaveBeenCalled();

      releaseCandidate.resolve();
      await rebuilding;

      expect(workspace.workspaceSymbols('BeforeRebuild')).toEqual([]);
      expect(workspace.workspaceSymbols('AfterRebuild')).toHaveLength(1);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 2,
        warningCount: 0,
      });
    } finally {
      releaseCandidate.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for rebuildable workspaces before dispatching rebuilds', async () => {
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
    };
    const rebuild = rebuildWorkspaces(fakeConnection, manager as never);
    await flushPromises();

    expect(calls).toEqual(['rebuildableList']);
    expect(workspace.rebuild).not.toHaveBeenCalled();

    ready.resolve();
    await rebuild;

    expect(calls).toEqual(['rebuildableList', 'ready', 'rebuild']);
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

    const rebuilding = rebuildWorkspaces(
      fakeConnection,
      manager as never,
    );
    await flushPromises();

    expect(calls).toEqual(['slow:start', 'ready:done']);
    slow.resolve();
    await rebuilding;
    expect(calls).toEqual(['slow:start', 'ready:done', 'slow:done']);
  });

  it('scoped settings reconfiguration clears symbols excluded by the new settings', async () => {
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
    expect(workspace.workspaceSymbols('KeepSymbol').length).toBeGreaterThanOrEqual(1);
    expect(workspace.workspaceSymbols('StaleSymbol').length).toBeGreaterThanOrEqual(1);

    await applyScopedSettingsAndRebuild(
      fakeConnection,
      manager,
      async () => ({
        ...DEFAULT_SETTINGS,
        excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, 'Assets/Shaders/Stale.hlsl'],
      }),
    );

    expect(workspace.workspaceSymbols('KeepSymbol').length).toBeGreaterThanOrEqual(1);
    expect(workspace.workspaceSymbols('StaleSymbol')).toEqual([]);
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
      );

      const workspaceA = manager.workspaceFor(pathToFileURL(join(projectA, 'Assets', 'Shaders', 'Common.hlsl')).href);
      const workspaceB = manager.workspaceFor(pathToFileURL(join(projectB, 'Assets', 'Shaders', 'OnlyInB.hlsl')).href);

      expect(workspaceA?.workspaceSymbols('Common').length).toBeGreaterThanOrEqual(1);
      expect(workspaceB?.workspaceSymbols('OnlyInB').length).toBeGreaterThanOrEqual(1);
      expect(workspaceB?.workspaceSymbols('Common')).toEqual([]);
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
      workspaceForOrCreateFile: vi.fn(),
    };

    await applyScopedSettingsAndRebuild(
      fakeConnection,
      manager as never,
      async () => nextSettings,
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
    );

    expect(initialWorkspace.reconfigure).toHaveBeenCalledWith(fakeConnection, nextSettings);
    expect(readyWorkspace.reconfigure).toHaveBeenCalledWith(fakeConnection, nextSettings);
    slow.resolve();
  });

  it('decides queued S0 -> S1 -> S0 rebuilds from the settings active at execution time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-settings-reversal-'));
    const releaseInitial = deferred();
    const initialIndexingStarted = deferred();
    const releaseFinal = deferred();
    const finalIndexingStarted = deferred();
    try {
      const open = openDocument(
        'QUEUED_DECL(Unsaved)',
        1,
        1,
        pathToFileURL(join(root, 'Open.hlsl')).href,
      );
      const tableStates: boolean[] = [];
      let indexingAttempt = 0;
      const workspace = new Workspace(
        pathToFileURL(root).href,
        DEFAULT_SETTINGS,
        {
          ensureParserReady: async () => {},
          indexImplementation: null,
          openDocuments: () => [open],
          async indexDocument(uri, text, recognizer) {
            indexingAttempt++;
            const indexed = await indexFile(uri, text, recognizer);
            tableStates.push(indexed.symbols.some((symbol) => symbol.name === 'Unsaved'));
            if (indexingAttempt === 1) {
              initialIndexingStarted.resolve();
              await releaseInitial.promise;
            } else if (indexingAttempt === 3) {
              finalIndexingStarted.resolve();
              await releaseFinal.promise;
            }
            return indexed;
          },
        },
      );
      const manager = {
        list: () => [workspace],
      };
      const settings1 = {
        ...DEFAULT_SETTINGS,
        declarationMacros: [{ pattern: 'QUEUED_DECL($name)', kind: 'variable' as const }],
      };

      const initializing = workspace.initialize(fakeConnection);
      await initialIndexingStarted.promise;
      await applyScopedSettingsAndRebuild(
        fakeConnection,
        manager as never,
        async () => settings1,
      );
      await applyScopedSettingsAndRebuild(
        fakeConnection,
        manager as never,
        async () => DEFAULT_SETTINGS,
      );

      releaseInitial.resolve();
      await finalIndexingStarted.promise;

      expect(tableStates).toEqual([false, true, false]);
      expect(workspace.settings.declarationMacros).toEqual(settings1.declarationMacros);
      expect(workspace.workspaceSymbols('Unsaved')).toHaveLength(1);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'indexing',
        operation: 'rebuild',
        servingRevision: 2,
      });

      releaseFinal.resolve();
      await initializing;
      for (let i = 0; i < 100; i++) {
        const lifecycle = workspace.indexStatus().lifecycle;
        if (
          lifecycle.state === 'ready'
          && lifecycle.revision === 3
        ) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 0));
      }

      expect(workspace.workspaceSymbols('Unsaved')).toEqual([]);
      expect(workspace.settings).toEqual(DEFAULT_SETTINGS);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 3,
        warningCount: 0,
      });
    } finally {
      releaseInitial.resolve();
      releaseFinal.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });
});
