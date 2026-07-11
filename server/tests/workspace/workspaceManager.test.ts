import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { CacheManager } from '../../src/cache/cacheManager';
import { WorkspaceManager } from '../../src/workspace/workspaceManager';
import { Workspace } from '../../src/workspace/workspace';
import {
  copyUnityProjectFixture,
  removeCopiedUnityProject,
} from '../helpers/copiedUnityProject';

const projectASource = resolve(__dirname, '../include/fixtures/projectA');
let projectA: string;

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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  }
  throw new Error('condition was not met');
}

beforeEach(async () => {
  projectA = await copyUnityProjectFixture(projectASource);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeCopiedUnityProject(projectA);
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
  it.runIf(process.platform === 'win32')('routes files when the URI casing differs on Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-case-route-'));
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockResolvedValue(undefined);

    await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, fakeConnection);

    const upperCasedFile = pathToFileURL(join(root.toUpperCase(), 'Assets', 'Shaders', 'Main.shader')).href;
    expect(manager.workspaceFor(upperCasedFile)?.folderUri).toBe(pathToFileURL(root).href);
  });

  it('routes files to their owning workspace and keeps indexes isolated', async () => {
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
    expect(workspaceA?.index.global.lookup('OnlyInB')).toEqual([]);
    expect(workspaceB?.index.global.lookup('Common')).toEqual([]);
  });

  it('reports a ready Unity workspace in the lifecycle snapshot', async () => {
    const manager = new WorkspaceManager();

    expect(manager.statusSnapshot()).toEqual({ statusSequence: 0, workspaces: [] });
    await manager.addFolder(pathToFileURL(projectA).href, DEFAULT_SETTINGS, fakeConnection);

    expect(manager.statusSnapshot()).toEqual({
      statusSequence: 2,
      workspaces: [{
        folderUri: pathToFileURL(projectA).href,
        mode: 'unity',
        lifecycle: { state: 'ready', revision: 1, warningCount: 0 },
      }],
    });
  });

  it('publishes full snapshots for add, initial completion, rebuild, and remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-status-sequence-'));
    const folderUri = pathToFileURL(root).href;
    const initial = deferred();
    const notifications: Array<{ name: string; snapshot: unknown }> = [];
    const connection = {
      ...fakeConnection,
      console: { log() {}, error() {} },
      sendNotification(name: string, snapshot: unknown) {
        notifications.push({ name, snapshot });
      },
    } as never;
    vi.spyOn(Workspace.prototype, 'bootstrap')
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValue(undefined);
    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, connection);

    const add = manager.addFolder(folderUri, DEFAULT_SETTINGS, connection);
    await flushPromises();
    expect(notifications).toMatchObject([{
      name: 'unityShaderNav/indexStatusChanged',
      snapshot: {
        statusSequence: 1,
        workspaces: [{
          folderUri,
          lifecycle: { state: 'indexing', operation: 'initial' },
        }],
      },
    }]);

    initial.resolve();
    await add;
    const workspace = manager.list()[0];
    await workspace.rebuild(connection);
    await manager.removeFolder(folderUri);

    expect(notifications.map(({ snapshot }) => (
      (snapshot as { statusSequence: number }).statusSequence
    ))).toEqual([1, 2, 3, 4, 5]);
    expect(notifications.map(({ snapshot }) => {
      const workspaces = (snapshot as { workspaces: Array<{ lifecycle: { state: string } }> }).workspaces;
      return workspaces[0]?.lifecycle.state ?? 'absent';
    })).toEqual(['indexing', 'ready', 'indexing', 'ready', 'absent']);
    expect(manager.statusSnapshot()).toEqual({ statusSequence: 5, workspaces: [] });
    await rm(root, { recursive: true, force: true });
  });

  it('keeps lifecycle state authoritative when notification delivery rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-status-send-failure-'));
    const error = vi.fn();
    const connection = {
      ...fakeConnection,
      console: { log() {}, error },
      sendNotification: vi.fn(async () => {
        throw new Error('transport closed');
      }),
    } as never;
    vi.spyOn(Workspace.prototype, 'bootstrap').mockResolvedValue(0);
    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, connection);

    await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, connection);
    await flushPromises();

    expect(manager.statusSnapshot()).toMatchObject({
      statusSequence: 2,
      workspaces: [{ lifecycle: { state: 'ready', revision: 1 } }],
    });
    expect(error).toHaveBeenCalledWith(
      '[UnityShaderNav] index status notification failed: transport closed',
    );
    await rm(root, { recursive: true, force: true });
  });

  it('uses the settings passed for a newly added folder', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-latest-settings-'));
    const manager = new WorkspaceManager();

    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    await manager.addFolder(
      pathToFileURL(standaloneFolder).href,
      { ...DEFAULT_SETTINGS, projectRoot: projectA },
      fakeConnection,
    );

    const workspace = manager.list()[0];
    expect(workspace.unityRoot).toBe(projectA);
    expect(workspace.index.global.lookup('Common').length).toBeGreaterThanOrEqual(1);
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

  it('awaits an in-flight folder bootstrap before returning an existing workspace', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-ready-existing-'));
    const fileUri = pathToFileURL(join(standaloneFolder, 'Loose.hlsl')).href;
    const ready = deferred();
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockReturnValue(ready.promise);

    const addFolder = manager.addFolder(
      pathToFileURL(standaloneFolder).href,
      DEFAULT_SETTINGS,
      fakeConnection,
    );
    await flushPromises();

    let settled = false;
    const workspacePromise = manager.workspaceForOrCreateFile(fileUri).then((workspace) => {
      settled = true;
      return workspace;
    });
    await flushPromises();

    expect(settled).toBe(false);
    ready.resolve();

    await expect(workspacePromise).resolves.toBe(manager.workspaceFor(fileUri));
    await addFolder;
  });

  it('coalesces concurrent lazy creation for the same folder into one bootstrap', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-ready-lazy-'));
    const fileA = pathToFileURL(join(standaloneFolder, 'A.hlsl')).href;
    const fileB = pathToFileURL(join(standaloneFolder, 'B.hlsl')).href;
    const ready = deferred();
    const manager = new WorkspaceManager();
    const bootstrap = vi.spyOn(Workspace.prototype, 'bootstrap').mockReturnValue(ready.promise);
    manager.configure(DEFAULT_SETTINGS, fakeConnection);

    let firstSettled = false;
    let secondSettled = false;
    const first = manager.workspaceForOrCreateFile(fileA).then((workspace) => {
      firstSettled = true;
      return workspace;
    });
    const second = manager.workspaceForOrCreateFile(fileB).then((workspace) => {
      secondSettled = true;
      return workspace;
    });
    await waitFor(() => bootstrap.mock.calls.length > 0);
    await flushPromises();

    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    ready.resolve();

    const [workspaceA, workspaceB] = await Promise.all([first, second]);
    expect(workspaceA).toBe(workspaceB);
  });

  it('does not let an indexing root block ready roots in cross-root queries', async () => {
    const readyRoot = await mkdtemp(join(tmpdir(), 'usn-ready-root-'));
    const slowRoot = await mkdtemp(join(tmpdir(), 'usn-indexing-root-'));
    const readyUri = pathToFileURL(readyRoot).href;
    const slowUri = pathToFileURL(slowRoot).href;
    const slow = deferred();
    const manager = new WorkspaceManager();
    const bootstrap = vi.spyOn(Workspace.prototype, 'bootstrap')
      .mockImplementation(function bootstrap(this: Workspace) {
        return this.folderUri === slowUri ? slow.promise : Promise.resolve();
      });
    let addingSlow: Promise<void> | undefined;

    try {
      await manager.addFolder(readyUri, DEFAULT_SETTINGS, fakeConnection);
      addingSlow = manager.addFolder(slowUri, DEFAULT_SETTINGS, fakeConnection);
      await waitFor(() => manager.statusSnapshot().workspaces.some((workspace) => (
        workspace.folderUri === slowUri && workspace.lifecycle.state === 'indexing'
      )));

      await expect(manager.readyList()).resolves.toMatchObject([{ folderUri: readyUri }]);
      await expect(manager.rebuildableList()).resolves.toMatchObject([{ folderUri: readyUri }]);
      expect(bootstrap).toHaveBeenCalledTimes(2);
    } finally {
      slow.resolve();
      await addingSlow;
      await rm(readyRoot, { recursive: true, force: true });
      await rm(slowRoot, { recursive: true, force: true });
    }
  });

  it('does not let an unrelated initial root block a later root from becoming ready', async () => {
    const slowRoot = await mkdtemp(join(tmpdir(), 'usn-add-slow-root-'));
    const readyRoot = await mkdtemp(join(tmpdir(), 'usn-add-independent-root-'));
    const slowUri = pathToFileURL(slowRoot).href;
    const readyUri = pathToFileURL(readyRoot).href;
    const slow = deferred<number>();
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockImplementation(function bootstrap(this: Workspace) {
      return this.folderUri === slowUri ? slow.promise : Promise.resolve(0);
    });
    const addingSlow = manager.addFolder(slowUri, DEFAULT_SETTINGS, fakeConnection);

    try {
      await waitFor(() => manager.list().some((workspace) => workspace.folderUri === slowUri));
      await manager.addFolder(readyUri, DEFAULT_SETTINGS, fakeConnection);

      expect(manager.servingWorkspaceFor(pathToFileURL(join(readyRoot, 'Ready.hlsl')).href))
        .toMatchObject({ folderUri: readyUri });
    } finally {
      await manager.removeFolder(slowUri);
      await manager.removeFolder(readyUri);
      slow.resolve(0);
      await addingSlow;
      await rm(slowRoot, { recursive: true, force: true });
      await rm(readyRoot, { recursive: true, force: true });
    }
  });

  it('returns request-facing workspace readiness immediately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-serving-root-'));
    const folderUri = pathToFileURL(root).href;
    const fileUri = pathToFileURL(join(root, 'Slow.hlsl')).href;
    const initial = deferred();
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockReturnValue(initial.promise);

    const adding = manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
    await flushPromises();

    expect(manager.servingWorkspaceFor(fileUri)).toBeUndefined();
    await expect(manager.readyWorkspaceFor(fileUri)).resolves.toBeUndefined();

    initial.resolve();
    await adding;
    expect(manager.servingWorkspaceFor(fileUri)).toBe(manager.workspaceFor(fileUri));
    await rm(root, { recursive: true, force: true });
  });

  it('retains failed bootstrap records while excluding them from ready workspace lists', async () => {
    const failedFolder = await mkdtemp(join(tmpdir(), 'usn-ready-failed-'));
    const failed = deferred();
    const manager = new WorkspaceManager();
    const bootstrap = vi
      .spyOn(Workspace.prototype, 'bootstrap')
      .mockReturnValueOnce(failed.promise);

    const addFolder = manager.addFolder(
      pathToFileURL(failedFolder).href,
      DEFAULT_SETTINGS,
      fakeConnection,
    );
    await flushPromises();
    const readyList = manager.readyList();

    failed.reject(new Error('bootstrap failed'));

    await expect(addFolder).resolves.toBeUndefined();
    await expect(readyList).resolves.toEqual([]);
    expect(manager.list()).toHaveLength(1);
    await expect(manager.rebuildableList()).resolves.toMatchObject([{
      folderUri: pathToFileURL(failedFolder).href,
    }]);
    expect(manager.statusSnapshot()).toMatchObject({
      statusSequence: 2,
      workspaces: [{
        folderUri: pathToFileURL(failedFolder).href,
        lifecycle: {
          state: 'failed',
          failure: { category: 'indexing', message: 'bootstrap failed' },
        },
      }],
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);

    await manager.removeFolder(pathToFileURL(failedFolder).href);
    expect(manager.statusSnapshot()).toEqual({ statusSequence: 3, workspaces: [] });
  });

  it('removes an indexing root without waiting for its bootstrap to settle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-remove-indexing-'));
    const folderUri = pathToFileURL(root).href;
    const initial = deferred();
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockReturnValue(initial.promise);
    const adding = manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
    await flushPromises();

    await expect(manager.removeFolder(folderUri)).resolves.toBeUndefined();
    expect(manager.statusSnapshot()).toEqual({ statusSequence: 2, workspaces: [] });

    initial.resolve();
    await adding;
    expect(manager.statusSnapshot()).toEqual({ statusSequence: 2, workspaces: [] });
    await rm(root, { recursive: true, force: true });
  });

  it('retires waiters and lets a remove/re-add pair publish only the new workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-remove-readd-'));
    const folderUri = pathToFileURL(root).href;
    const fileUri = pathToFileURL(join(root, 'Loose.hlsl')).href;
    const oldInitial = deferred();
    const bootstrap = vi.spyOn(Workspace.prototype, 'bootstrap')
      .mockReturnValueOnce(oldInitial.promise)
      .mockResolvedValueOnce(0);
    const manager = new WorkspaceManager();

    const oldAdding = manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
    await flushPromises();
    const oldWorkspace = manager.list()[0];
    const oldWaiter = manager.workspaceForOrCreateFile(fileUri);

    await manager.removeFolder(folderUri);
    await expect(oldWaiter).resolves.toBeUndefined();
    await manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);

    const newWorkspace = manager.list()[0];
    expect(newWorkspace).not.toBe(oldWorkspace);
    expect(manager.servingWorkspaceFor(fileUri)).toBe(newWorkspace);

    oldInitial.resolve();
    await oldAdding;
    expect(manager.list()).toEqual([newWorkspace]);
    expect(manager.statusSnapshot()).toMatchObject({
      statusSequence: 4,
      workspaces: [{ lifecycle: { state: 'ready', revision: 1 } }],
    });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    await rm(root, { recursive: true, force: true });
  });

  it('replays an open unsaved snapshot into a remove/re-add replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-remove-readd-open-'));
    const folderUri = pathToFileURL(root).href;
    const fileUri = pathToFileURL(join(root, 'Open.hlsl')).href;
    const text = [
      'float4 UnsavedAcrossReadd() { return 0; }',
      'float4 Caller() { return UnsavedAcrossReadd(); }',
    ].join('\n');
    const document = {
      uri: fileUri,
      languageId: 'hlsl',
      text,
      openId: 1,
      version: 4,
    };
    const manager = new WorkspaceManager();
    manager.configureOpenDocumentsProvider(() => [document]);

    try {
      await manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
      const first = manager.servingWorkspaceFor(fileUri);
      expect(await first?.definitionAt({
        document,
        position: { line: 1, character: 27 },
      })).toHaveLength(1);

      await manager.removeFolder(folderUri);
      await manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
      const replacement = manager.servingWorkspaceFor(fileUri);
      expect(replacement).not.toBe(first);
      expect(await replacement?.definitionAt({
        document,
        position: { line: 1, character: 27 },
      })).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses scoped settings when lazily creating a workspace for a file', async () => {
    const looseFolder = await mkdtemp(join(tmpdir(), 'usn-lazy-scoped-'));
    const looseFile = join(looseFolder, 'Loose.hlsl');
    await writeFile(looseFile, 'MY_TEX2D(_LazyTex)');
    const manager = new WorkspaceManager();

    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    manager.configureSettingsResolver(async (uri) => uri.startsWith(pathToFileURL(looseFolder).href)
      ? {
          ...DEFAULT_SETTINGS,
          projectRoot: projectA,
          declarationMacros: [{ pattern: 'MY_TEX2D($name)', kind: 'variable' }],
        }
      : DEFAULT_SETTINGS);

    const workspace = await manager.workspaceForOrCreateFile(pathToFileURL(looseFile).href);
    await workspace?.updateDocument({
      uri: pathToFileURL(looseFile).href,
      languageId: 'hlsl',
      text: 'MY_TEX2D(_LazyTex)',
      openId: 1,
      version: 1,
    });

    expect(workspace?.unityRoot).toBe(projectA);
    expect(workspace?.index.store.get(pathToFileURL(looseFile).href)?.symbols).toMatchObject([
      { name: '_LazyTex', kind: 'variable' },
    ]);
  });

  it('cancels lazy creation when the document closes during settings lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lazy-cancel-settings-'));
    const fileUri = pathToFileURL(join(root, 'Loose.hlsl')).href;
    const settingsStarted = deferred();
    const releaseSettings = deferred();
    let open = true;
    const manager = new WorkspaceManager();
    manager.configureRuntime(fakeConnection);
    manager.configureSettingsResolver(async () => {
      settingsStarted.resolve();
      await releaseSettings.promise;
      return DEFAULT_SETTINGS;
    });

    try {
      const creating = manager.workspaceForOrCreateFile(fileUri, () => open);
      await settingsStarted.promise;
      open = false;
      releaseSettings.resolve();

      await expect(creating).resolves.toBeUndefined();
      expect(manager.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retires a lazy bootstrap when its last open document closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lazy-release-bootstrap-'));
    const fileUri = pathToFileURL(join(root, 'Loose.hlsl')).href;
    const bootstrap = deferred<number>();
    let openDocuments = [{
      uri: fileUri,
      languageId: 'hlsl',
      text: 'float4 Unsaved() { return 0; }',
      openId: 1,
      version: 1,
    }];
    vi.spyOn(Workspace.prototype, 'bootstrap').mockReturnValue(bootstrap.promise);
    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    manager.configureOpenDocumentsProvider(() => openDocuments);

    try {
      const creating = manager.workspaceForOrCreateFile(fileUri, () => openDocuments.length > 0);
      await waitFor(() => manager.list().length === 1);
      openDocuments = [];
      await manager.releaseDocument(fileUri);

      expect(manager.list()).toEqual([]);
      await expect(creating).resolves.toBeUndefined();
      bootstrap.resolve(0);
      await flushPromises();
      expect(manager.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('moves live-document ownership across nested workspace add and remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-nested-live-owner-'));
    const nested = join(root, 'Nested');
    const rootUri = pathToFileURL(root).href;
    const nestedUri = pathToFileURL(nested).href;
    const fileUri = pathToFileURL(join(nested, 'Live.hlsl')).href;
    await mkdir(nested, { recursive: true });
    let openDocuments = [{
      uri: fileUri,
      languageId: 'hlsl',
      text: 'float4 ParentOwned() { return 0; }',
      openId: 1,
      version: 1,
    }];
    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    manager.configureOpenDocumentsProvider(() => openDocuments);

    try {
      await manager.addFolder(rootUri, DEFAULT_SETTINGS, fakeConnection);
      const parent = manager.workspaceFor(fileUri)!;
      expect(parent.index.global.lookup('ParentOwned')).toHaveLength(1);

      const ownershipStarted = deferred();
      const releaseOwnership = deferred();
      const synchronizeParent = parent.synchronizeOpenDocuments.bind(parent);
      const parentSynchronization = vi
        .spyOn(parent, 'synchronizeOpenDocuments')
        .mockImplementationOnce(async () => {
          ownershipStarted.resolve();
          await releaseOwnership.promise;
          await synchronizeParent();
        });
      const addingNested = manager.addFolder(nestedUri, DEFAULT_SETTINGS, fakeConnection);
      await ownershipStarted.promise;
      expect(manager.workspaceFor(fileUri)?.canServe()).toBe(false);
      releaseOwnership.resolve();
      await addingNested;

      const child = manager.workspaceFor(fileUri)!;
      expect(child).not.toBe(parent);
      expect(child.index.global.lookup('ParentOwned')).toHaveLength(1);
      expect(parent.index.global.lookup('ParentOwned')).toEqual([]);

      openDocuments = [{
        ...openDocuments[0],
        text: 'float4 ChildOwnedV2() { return 0; }',
        version: 2,
      }];
      await child.updateDocument(openDocuments[0]);
      const replacementStarted = deferred();
      const releaseReplacement = deferred();
      parentSynchronization.mockImplementationOnce(async () => {
        replacementStarted.resolve();
        await releaseReplacement.promise;
        await synchronizeParent();
      });
      const removingNested = manager.removeFolder(nestedUri);
      await replacementStarted.promise;
      expect(manager.servingWorkspaceFor(fileUri)).toBeUndefined();
      releaseReplacement.resolve();
      await removingNested;

      expect(manager.workspaceFor(fileUri)).toBe(parent);
      expect(manager.servingWorkspaceFor(fileUri)).toBe(parent);
      expect(parent.index.global.lookup('ParentOwned')).toEqual([]);
      expect(parent.index.global.lookup('ChildOwnedV2')).toHaveLength(1);

      await manager.addFolder(nestedUri, DEFAULT_SETTINGS, fakeConnection);
      const replacement = manager.workspaceFor(fileUri)!;
      expect(replacement).not.toBe(parent);
      expect(replacement.index.global.lookup('ChildOwnedV2')).toHaveLength(1);
      expect(parent.index.global.lookup('ChildOwnedV2')).toEqual([]);

      openDocuments = [];
      await replacement.closeDocument({ uri: fileUri, openId: 1 });
      await manager.removeFolder(nestedUri);

      expect(manager.workspaceFor(fileUri)).toBe(parent);
      expect(parent.index.global.lookup('ChildOwnedV2')).toEqual([]);
    } finally {
      await manager.removeFolder(nestedUri);
      await manager.removeFolder(rootUri);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retires a transient parent after a persistent nested root takes its last document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-transient-parent-owner-'));
    const nested = join(root, 'Nested');
    const filePath = join(nested, 'Live.hlsl');
    const fileUri = pathToFileURL(filePath).href;
    const rootUri = pathToFileURL(root).href;
    const nestedUri = pathToFileURL(nested).href;
    await mkdir(join(root, 'Assets'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(root, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.0f1\n',
    );
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}\n');
    await writeFile(filePath, 'float4 SavedOnDisk() { return 0; }');
    let openDocuments = [{
      uri: fileUri,
      languageId: 'hlsl',
      text: 'float4 UnsavedInEditor() { return 0; }',
      openId: 1,
      version: 1,
    }];
    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    manager.configureOpenDocumentsProvider(() => openDocuments);

    try {
      const transientParent = await manager.workspaceForOrCreateFile(fileUri);
      expect(transientParent?.folderUri).toBe(rootUri);
      expect(manager.list()).toHaveLength(1);

      await manager.addFolder(nestedUri, DEFAULT_SETTINGS, fakeConnection);

      expect(manager.workspaceFor(fileUri)?.folderUri).toBe(nestedUri);
      expect(manager.list().map((workspace) => workspace.folderUri)).toEqual([nestedUri]);
      expect(transientParent?.canServe()).toBe(false);

      await manager.removeFolder(nestedUri);
      expect(manager.workspaceFor(fileUri)).toBeUndefined();
      const rerouted = await manager.workspaceForOrCreateFile(
        fileUri,
        () => openDocuments[0]?.openId === 1,
      );
      expect(rerouted?.folderUri).toBe(rootUri);
      expect(rerouted).not.toBe(transientParent);
      expect(rerouted?.index.global.lookup('UnsavedInEditor')).toHaveLength(1);
    } finally {
      openDocuments = [];
      await manager.removeFolder(nestedUri);
      await manager.removeFolder(rootUri);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps parent and nested disk baselines current across ownership transfer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-nested-disk-baseline-'));
    const nested = join(root, 'Assets', 'Nested');
    const filePath = join(nested, 'Live.hlsl');
    const fileUri = pathToFileURL(filePath).href;
    const rootUri = pathToFileURL(root).href;
    const nestedUri = pathToFileURL(nested).href;
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await writeFile(
      join(root, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.0f1\n',
    );
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}\n');
    await writeFile(filePath, 'float4 DiskV1() { return 0; }');
    let openDocuments = [{
      uri: fileUri,
      languageId: 'hlsl',
      text: 'float4 LiveOverlay() { return 0; }',
      openId: 1,
      version: 1,
    }];
    const manager = new WorkspaceManager();
    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    manager.configureOpenDocumentsProvider(() => openDocuments);

    try {
      await manager.addFolder(rootUri, DEFAULT_SETTINGS, fakeConnection);
      const parent = manager.workspaceFor(fileUri)!;
      await manager.addFolder(nestedUri, DEFAULT_SETTINGS, fakeConnection);
      const child = manager.workspaceFor(fileUri)!;
      expect(child).not.toBe(parent);

      await writeFile(filePath, 'float4 DiskV2() { return 0; }');
      const diskOwners = manager.readyWorkspacesFor(fileUri);
      expect(new Set(diskOwners)).toEqual(new Set([parent, child]));
      await Promise.all(diskOwners.map((workspace) => workspace.applyChanges(
        [{ uri: fileUri, type: 'changed' }],
        fakeConnection,
      )));

      await manager.removeFolder(nestedUri);
      expect(manager.workspaceFor(fileUri)).toBe(parent);
      expect(parent.index.global.lookup('LiveOverlay')).toHaveLength(1);

      openDocuments = [];
      await parent.closeDocument({ uri: fileUri, openId: 1 });
      expect(parent.index.global.lookup('DiskV1')).toEqual([]);
      expect(parent.index.global.lookup('DiskV2')).toHaveLength(1);
      expect(parent.index.global.lookup('LiveOverlay')).toEqual([]);
    } finally {
      await manager.removeFolder(nestedUri);
      await manager.removeFolder(rootUri);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fans out only to existing baselines or exact scan candidates', async () => {
    const unityRoot = await mkdtemp(join(tmpdir(), 'usn-external-project-root-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'usn-external-workspace-'));
    const externalPackageRoot = join(externalRoot, 'ExternalPackage');
    const externalPath = join(externalPackageRoot, 'External.hlsl');
    const workspaceOnlyPath = join(externalRoot, 'WorkspaceOnly.hlsl');
    const externalUri = pathToFileURL(externalPath).href;
    const workspaceOnlyUri = pathToFileURL(workspaceOnlyPath).href;
    const externalRootUri = pathToFileURL(externalRoot).href;
    await mkdir(join(unityRoot, 'Assets'), { recursive: true });
    await mkdir(join(unityRoot, 'ProjectSettings'), { recursive: true });
    await mkdir(join(unityRoot, 'Packages', 'Unlisted'), { recursive: true });
    await mkdir(join(unityRoot, 'Library'), { recursive: true });
    await mkdir(join(unityRoot, 'Assets', 'Generated'), { recursive: true });
    await mkdir(join(externalPackageRoot, 'Documentation~'), { recursive: true });
    await writeFile(
      join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.0f1\n',
    );
    await writeFile(join(unityRoot, 'Packages', 'packages-lock.json'), JSON.stringify({
      dependencies: {
        'com.example.external': {
          version: `file:${externalPackageRoot}`,
          depth: 0,
          source: 'local',
          dependencies: {},
        },
      },
    }));
    await writeFile(externalPath, 'float4 ExternalDiskV1() { return 0; }');
    await writeFile(workspaceOnlyPath, 'float4 WorkspaceOnly() { return 0; }');
    const unlistedUri = pathToFileURL(join(unityRoot, 'Packages', 'Unlisted', 'Hidden.hlsl')).href;
    const excludedUri = pathToFileURL(join(unityRoot, 'Library', 'Generated.hlsl')).href;
    const exactDirectoryExcludedUri = pathToFileURL(
      join(unityRoot, 'Assets', 'Generated', 'Hidden.hlsl'),
    ).href;
    const packageDocumentationUri = pathToFileURL(
      join(externalPackageRoot, 'Documentation~', 'Example.hlsl'),
    ).href;
    await writeFile(fileURLToPath(unlistedUri), 'float4 MustStayUnlisted() { return 0; }');
    await writeFile(fileURLToPath(excludedUri), 'float4 MustStayExcluded() { return 0; }');
    await writeFile(
      fileURLToPath(exactDirectoryExcludedUri),
      'float4 ExactDirectoryExcluded() { return 0; }',
    );
    await writeFile(
      fileURLToPath(packageDocumentationUri),
      'float4 PackageDocumentationExcluded() { return 0; }',
    );
    const settings = {
      ...DEFAULT_SETTINGS,
      projectRoot: unityRoot,
      excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, 'Assets/Generated'],
    };
    let openDocuments = [{
      uri: externalUri,
      languageId: 'hlsl',
      text: 'float4 ExternalLive() { return 0; }',
      openId: 1,
      version: 1,
    }];
    const manager = new WorkspaceManager();
    manager.configure(settings, fakeConnection);
    manager.configureOpenDocumentsProvider(() => openDocuments);

    try {
      await manager.addFolder(externalRootUri, settings, fakeConnection);
      const workspace = manager.workspaceFor(externalUri)!;
      expect(manager.readyWorkspacesFor(externalUri)).toEqual([workspace]);
      expect(manager.readyWorkspacesFor(workspaceOnlyUri)).toEqual([]);
      expect(manager.readyWorkspacesFor(unlistedUri)).toEqual([]);
      expect(manager.readyWorkspacesFor(excludedUri)).toEqual([]);
      expect(manager.readyWorkspacesFor(exactDirectoryExcludedUri)).toEqual([]);
      expect(manager.readyWorkspacesFor(packageDocumentationUri)).toEqual([]);

      await writeFile(externalPath, 'float4 ExternalDiskV2() { return 0; }');
      await workspace.applyChanges(
        [{ uri: externalUri, type: 'changed' }],
        fakeConnection,
      );
      expect(workspace.index.global.lookup('ExternalLive')).toHaveLength(1);

      openDocuments = [];
      await workspace.closeDocument({ uri: externalUri, openId: 1 });
      expect(workspace.index.global.lookup('ExternalDiskV1')).toEqual([]);
      expect(workspace.index.global.lookup('ExternalDiskV2')).toHaveLength(1);
      expect(workspace.index.global.lookup('ExternalLive')).toEqual([]);
    } finally {
      openDocuments = [];
      await manager.removeFolder(externalRootUri);
      await rm(unityRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
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

  it('persists ready roots without waiting for an unrelated initial root', async () => {
    const readyRoot = await mkdtemp(join(tmpdir(), 'usn-persist-ready-'));
    const slowRoot = await mkdtemp(join(tmpdir(), 'usn-persist-slow-'));
    const readyUri = pathToFileURL(readyRoot).href;
    const slowUri = pathToFileURL(slowRoot).href;
    const slow = deferred();
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockImplementation(function bootstrap(this: Workspace) {
      return this.folderUri === slowUri ? slow.promise : Promise.resolve(0);
    });
    const persist = vi.spyOn(Workspace.prototype, 'persist').mockResolvedValue(undefined);

    await manager.addFolder(readyUri, DEFAULT_SETTINGS, fakeConnection);
    const addingSlow = manager.addFolder(slowUri, DEFAULT_SETTINGS, fakeConnection);
    await flushPromises();

    await manager.persistAll();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.instances[0].folderUri).toBe(readyUri);

    await manager.removeFolder(slowUri);
    await addingSlow;
    slow.resolve();
    await flushPromises();
    await rm(readyRoot, { recursive: true, force: true });
    await rm(slowRoot, { recursive: true, force: true });
  });

  it('does not persist a root behind a rebuild that fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-persist-failed-rebuild-'));
    await mkdir(join(root, 'Assets'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    const manager = new WorkspaceManager();
    await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, fakeConnection);
    const workspace = manager.list()[0];
    vi.spyOn(workspace, 'bootstrap').mockRejectedValueOnce(new Error('rebuild failed'));
    const save = vi.spyOn(CacheManager.prototype, 'save').mockResolvedValue(undefined);

    const rebuilding = workspace.rebuild(fakeConnection);
    await manager.persistAll();
    await expect(rebuilding).rejects.toThrow('rebuild failed');

    expect(workspace.indexStatus().lifecycle).toMatchObject({ state: 'failed' });
    expect(save).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });

  it('does not wait for a queued rebuild before skipping best-effort persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-persist-pending-rebuild-'));
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockResolvedValueOnce(0);
    await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, fakeConnection);
    const workspace = manager.list()[0];
    const rebuildGate = deferred<number>();
    vi.spyOn(workspace, 'bootstrap').mockReturnValueOnce(rebuildGate.promise);

    const rebuilding = workspace.rebuild(fakeConnection);
    let persisted = false;
    const persisting = manager.persistAll().then(() => {
      persisted = true;
    });
    await flushPromises();

    try {
      expect(persisted).toBe(true);
    } finally {
      rebuildGate.resolve(0);
      await Promise.all([rebuilding, persisting]);
    }
    await rm(root, { recursive: true, force: true });
  });

  it('retires a ready workspace without a remove-time cache flush', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-remove-persist-'));
    const folderUri = pathToFileURL(standaloneFolder).href;
    const fileUri = pathToFileURL(join(standaloneFolder, 'Loose.hlsl')).href;
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockResolvedValue(undefined);
    const persist = vi.spyOn(Workspace.prototype, 'persist');
    const dispose = vi.spyOn(Workspace.prototype, 'dispose');

    await manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
    const workspace = manager.workspaceFor(fileUri);
    await manager.removeFolder(folderUri);

    expect(dispose).toHaveBeenCalledWith();
    expect(dispose.mock.instances).toContain(workspace);
    expect(persist).not.toHaveBeenCalled();
    expect(manager.workspaceFor(fileUri)).toBeUndefined();
  });
});
