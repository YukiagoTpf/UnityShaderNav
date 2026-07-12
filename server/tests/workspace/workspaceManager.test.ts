import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import {
  SymbolKind as LspSymbolKind,
  type DocumentSymbol,
} from 'vscode-languageserver/node';
import { CacheManager } from '../../src/cache/cacheManager';
import {
  DefaultIndexedRevisionCandidateConstructor,
  type IndexedRevisionCandidateConstructionInput,
} from '../../src/workspace/indexedRevisionCandidate';
import type { IndexedRevisionBuilder } from '../../src/workspace/indexedRevision';
import {
  WorkspaceManager,
  type WorkspaceManagerRuntimeOptions,
} from '../../src/workspace/workspaceManager';
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

type CandidateConstructionProceed = () => Promise<IndexedRevisionBuilder>;

function controlledCandidateConstruction(
  interceptor: (
    proceed: CandidateConstructionProceed,
    input: IndexedRevisionCandidateConstructionInput,
    folderUri: string,
  ) => Promise<IndexedRevisionBuilder>,
) {
  const construct = vi.fn((
    folderUri: string,
    input: IndexedRevisionCandidateConstructionInput,
    proceed: CandidateConstructionProceed,
  ) => interceptor(proceed, input, folderUri));
  const runtimeOptions = {
    createCandidateConstructor(folderUri: string) {
      const delegate = new DefaultIndexedRevisionCandidateConstructor({ folderUri });
      return {
        construct(input: IndexedRevisionCandidateConstructionInput) {
          return construct(folderUri, input, () => delegate.construct(input));
        },
      };
    },
  } satisfies WorkspaceManagerRuntimeOptions;
  return { construct, runtimeOptions };
}

function symbolsNamed(workspace: Workspace | undefined, name: string) {
  return workspace?.workspaceSymbols(name).filter((symbol) => symbol.name === name) ?? [];
}

async function documentSymbolsNamed(
  workspace: Workspace,
  uri: string,
  name: string,
): Promise<DocumentSymbol[]> {
  const symbols = await workspace.documentSymbols({ uri });
  const pending = [...(symbols ?? [])];
  const matches: DocumentSymbol[] = [];
  while (pending.length > 0) {
    const symbol = pending.shift()!;
    if (symbol.name === name) matches.push(symbol);
    if (symbol.children) pending.push(...symbol.children);
  }
  return matches;
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
    expect(symbolsNamed(workspaceA, 'OnlyInB')).toEqual([]);
    expect(symbolsNamed(workspaceB, 'Common')).toEqual([]);
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
    let constructionCount = 0;
    const construction = controlledCandidateConstruction(async (proceed) => {
      const constructionNumber = ++constructionCount;
      const candidate = await proceed();
      if (constructionNumber === 1) await initial.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
    const diagnosticsRefresh = vi.fn();
    manager.configureDiagnosticsRefresh(diagnosticsRefresh);
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
    expect(diagnosticsRefresh).toHaveBeenCalledTimes(5);
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
    expect(symbolsNamed(workspace, 'Common')).toHaveLength(1);
  });

  it('passes configured globalStorageDir to newly added workspaces', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-global-storage-'));
    const construction = controlledCandidateConstruction((proceed) => proceed());
    const manager = new WorkspaceManager(construction.runtimeOptions);

    manager.configure(DEFAULT_SETTINGS, fakeConnection, '/global-storage');
    await manager.addFolder(pathToFileURL(standaloneFolder).href, DEFAULT_SETTINGS, fakeConnection);

    expect(construction.construct).toHaveBeenCalledWith(
      pathToFileURL(standaloneFolder).href,
      expect.objectContaining({
        connection: fakeConnection,
        globalStorageDir: '/global-storage',
      }),
      expect.any(Function),
    );
  });

  it('awaits in-flight folder initialization before returning an existing workspace', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-ready-existing-'));
    const fileUri = pathToFileURL(join(standaloneFolder, 'Loose.hlsl')).href;
    const ready = deferred();
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      await ready.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);

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

  it('coalesces concurrent lazy creation for the same folder into one candidate construction', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-ready-lazy-'));
    const fileA = pathToFileURL(join(standaloneFolder, 'A.hlsl')).href;
    const fileB = pathToFileURL(join(standaloneFolder, 'B.hlsl')).href;
    const ready = deferred();
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      await ready.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
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
    await waitFor(() => construction.construct.mock.calls.length > 0);
    await flushPromises();

    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    expect(construction.construct).toHaveBeenCalledTimes(1);
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
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      if (candidate.configuration.folderUri === slowUri) await slow.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
    let addingSlow: Promise<void> | undefined;

    try {
      await manager.addFolder(readyUri, DEFAULT_SETTINGS, fakeConnection);
      addingSlow = manager.addFolder(slowUri, DEFAULT_SETTINGS, fakeConnection);
      await waitFor(() => manager.statusSnapshot().workspaces.some((workspace) => (
        workspace.folderUri === slowUri && workspace.lifecycle.state === 'indexing'
      )));

      await expect(manager.readyList()).resolves.toMatchObject([{ folderUri: readyUri }]);
      await expect(manager.rebuildableList()).resolves.toMatchObject([{ folderUri: readyUri }]);
      expect(construction.construct).toHaveBeenCalledTimes(2);
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
    const slow = deferred();
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      if (candidate.configuration.folderUri === slowUri) await slow.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
    const addingSlow = manager.addFolder(slowUri, DEFAULT_SETTINGS, fakeConnection);

    try {
      await waitFor(() => manager.list().some((workspace) => workspace.folderUri === slowUri));
      await manager.addFolder(readyUri, DEFAULT_SETTINGS, fakeConnection);

      expect(manager.servingWorkspaceFor(pathToFileURL(join(readyRoot, 'Ready.hlsl')).href))
        .toMatchObject({ folderUri: readyUri });
    } finally {
      await manager.removeFolder(slowUri);
      await manager.removeFolder(readyUri);
      slow.resolve();
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
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      await initial.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);

    const adding = manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
    await flushPromises();

    expect(manager.servingWorkspaceFor(fileUri)).toBeUndefined();
    await expect(manager.readyWorkspaceFor(fileUri)).resolves.toBeUndefined();

    initial.resolve();
    await adding;
    expect(manager.servingWorkspaceFor(fileUri)).toBe(manager.workspaceFor(fileUri));
    await rm(root, { recursive: true, force: true });
  });

  it('retains failed initialization records while excluding them from ready workspace lists', async () => {
    const failedFolder = await mkdtemp(join(tmpdir(), 'usn-ready-failed-'));
    const failConstruction = deferred();
    const construction = controlledCandidateConstruction(async (proceed) => {
      await proceed();
      await failConstruction.promise;
      throw new Error('candidate construction failed');
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);

    const addFolder = manager.addFolder(
      pathToFileURL(failedFolder).href,
      DEFAULT_SETTINGS,
      fakeConnection,
    );
    await flushPromises();
    const addFolderSettled = expect(addFolder).resolves.toBeUndefined();
    const readyList = manager.readyList();

    failConstruction.resolve();

    await addFolderSettled;
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
          failure: { category: 'indexing', message: 'candidate construction failed' },
        },
      }],
    });
    expect(construction.construct).toHaveBeenCalledTimes(1);

    await manager.removeFolder(pathToFileURL(failedFolder).href);
    expect(manager.statusSnapshot()).toEqual({ statusSequence: 3, workspaces: [] });
  });

  it('removes an indexing root without waiting for candidate construction to settle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-remove-indexing-'));
    const folderUri = pathToFileURL(root).href;
    const initial = deferred();
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      await initial.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
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
    let constructionCount = 0;
    const construction = controlledCandidateConstruction(async (proceed) => {
      const constructionNumber = ++constructionCount;
      const candidate = await proceed();
      if (constructionNumber === 1) await oldInitial.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);

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
    expect(construction.construct).toHaveBeenCalledTimes(2);
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
    expect(symbolsNamed(workspace, '_LazyTex')).toMatchObject([
      { name: '_LazyTex', kind: LspSymbolKind.Variable },
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

  it('retires a lazy initialization when its last open document closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-lazy-release-candidate-'));
    const fileUri = pathToFileURL(join(root, 'Loose.hlsl')).href;
    const candidateGate = deferred();
    let openDocuments = [{
      uri: fileUri,
      languageId: 'hlsl',
      text: 'float4 Unsaved() { return 0; }',
      openId: 1,
      version: 1,
    }];
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      await candidateGate.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
    manager.configure(DEFAULT_SETTINGS, fakeConnection);
    manager.configureOpenDocumentsProvider(() => openDocuments);

    try {
      const creating = manager.workspaceForOrCreateFile(fileUri, () => openDocuments.length > 0);
      await waitFor(() => manager.list().length === 1);
      openDocuments = [];
      await manager.releaseDocument(fileUri);

      expect(manager.list()).toEqual([]);
      await expect(creating).resolves.toBeUndefined();
      candidateGate.resolve();
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
      expect(symbolsNamed(parent, 'ParentOwned')).toHaveLength(1);

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
      expect(symbolsNamed(child, 'ParentOwned')).toHaveLength(1);
      expect(symbolsNamed(parent, 'ParentOwned')).toEqual([]);

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
      expect(symbolsNamed(parent, 'ParentOwned')).toEqual([]);
      expect(symbolsNamed(parent, 'ChildOwnedV2')).toHaveLength(1);

      await manager.addFolder(nestedUri, DEFAULT_SETTINGS, fakeConnection);
      const replacement = manager.workspaceFor(fileUri)!;
      expect(replacement).not.toBe(parent);
      expect(symbolsNamed(replacement, 'ChildOwnedV2')).toHaveLength(1);
      expect(symbolsNamed(parent, 'ChildOwnedV2')).toEqual([]);
      await expect(parent.updateDocument(openDocuments[0])).resolves.toBe(false);
      expect(symbolsNamed(parent, 'ChildOwnedV2')).toEqual([]);

      openDocuments = [];
      await replacement.closeDocument({ uri: fileUri, openId: 1 });
      await manager.removeFolder(nestedUri);

      expect(manager.workspaceFor(fileUri)).toBe(parent);
      expect(symbolsNamed(parent, 'ChildOwnedV2')).toEqual([]);
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
      expect(symbolsNamed(rerouted, 'UnsavedInEditor')).toHaveLength(1);
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
      expect(symbolsNamed(parent, 'LiveOverlay')).toHaveLength(1);

      openDocuments = [];
      await parent.closeDocument({ uri: fileUri, openId: 1 });
      expect(symbolsNamed(parent, 'DiskV1')).toEqual([]);
      expect(symbolsNamed(parent, 'DiskV2')).toHaveLength(1);
      expect(symbolsNamed(parent, 'LiveOverlay')).toEqual([]);
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
      expect(await documentSymbolsNamed(workspace, externalUri, 'ExternalLive')).toHaveLength(1);

      openDocuments = [];
      await workspace.closeDocument({ uri: externalUri, openId: 1 });
      expect(await documentSymbolsNamed(workspace, externalUri, 'ExternalDiskV1')).toEqual([]);
      expect(await documentSymbolsNamed(workspace, externalUri, 'ExternalDiskV2')).toHaveLength(1);
      expect(await documentSymbolsNamed(workspace, externalUri, 'ExternalLive')).toEqual([]);
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
    const construction = controlledCandidateConstruction(async (proceed) => {
      const candidate = await proceed();
      if (candidate.configuration.folderUri === slowUri) await slow.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
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

  it('persists the retained published revision after a rebuild fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-persist-failed-rebuild-'));
    await mkdir(join(root, 'Assets'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(
      join(root, 'Assets', 'Stable.hlsl'),
      'float4 StableBeforeFailure() { return 0; }',
    );
    let constructionCount = 0;
    const construction = controlledCandidateConstruction(async (proceed) => {
      constructionCount++;
      if (constructionCount === 2) throw new Error('rebuild failed');
      return proceed();
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
    await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, fakeConnection);
    const workspace = manager.list()[0];
    expect(symbolsNamed(workspace, 'StableBeforeFailure')).toHaveLength(1);
    const save = vi.spyOn(CacheManager.prototype, 'persistPublication')
      .mockResolvedValue(undefined);

    await expect(workspace.rebuild(fakeConnection)).rejects.toThrow('rebuild failed');

    expect(workspace.indexStatus().lifecycle).toMatchObject({
      state: 'failed',
      servingRevision: 1,
    });
    expect(symbolsNamed(workspace, 'StableBeforeFailure')).toHaveLength(1);

    await manager.persistAll();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({
          index: expect.objectContaining({
            symbols: expect.arrayContaining([
              expect.objectContaining({ name: 'StableBeforeFailure' }),
            ]),
          }),
        })]),
      }),
      expect.any(Function),
    );
    await rm(root, { recursive: true, force: true });
  });

  it('does not wait for a queued rebuild before skipping best-effort persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-persist-pending-rebuild-'));
    const rebuildGate = deferred();
    let constructionCount = 0;
    const construction = controlledCandidateConstruction(async (proceed) => {
      const constructionNumber = ++constructionCount;
      const candidate = await proceed();
      if (constructionNumber === 2) await rebuildGate.promise;
      return candidate;
    });
    const manager = new WorkspaceManager(construction.runtimeOptions);
    await manager.addFolder(pathToFileURL(root).href, DEFAULT_SETTINGS, fakeConnection);
    const workspace = manager.list()[0];

    const rebuilding = workspace.rebuild(fakeConnection);
    let persisted = false;
    const persisting = manager.persistAll().then(() => {
      persisted = true;
    });
    await flushPromises();

    try {
      expect(persisted).toBe(true);
    } finally {
      rebuildGate.resolve();
      await Promise.all([rebuilding, persisting]);
    }
    await rm(root, { recursive: true, force: true });
  });

  it('retires a ready workspace without a remove-time cache flush', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-remove-persist-'));
    const folderUri = pathToFileURL(standaloneFolder).href;
    const fileUri = pathToFileURL(join(standaloneFolder, 'Loose.hlsl')).href;
    const manager = new WorkspaceManager();
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
