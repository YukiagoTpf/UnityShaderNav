import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { WorkspaceManager } from '../../src/workspace/workspaceManager';
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

afterEach(() => {
  vi.restoreAllMocks();
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
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
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

  it('reports ready when any workspace is a Unity project', async () => {
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
    const manager = new WorkspaceManager();

    expect(manager.mode()).toBe('standalone');
    await manager.addFolder(pathToFileURL(projectA).href, DEFAULT_SETTINGS, fakeConnection);

    expect(manager.mode()).toBe('ready');
  });

  it('uses the settings passed for a newly added folder', async () => {
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
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

  it('filters failed bootstrap records from ready workspace lists', async () => {
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

    await expect(addFolder).rejects.toThrow('bootstrap failed');
    await expect(readyList).resolves.toEqual([]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('uses scoped settings when lazily creating a workspace for a file', async () => {
    const projectA = resolve(__dirname, '../include/fixtures/projectA');
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
    await workspace?.index.reindex(pathToFileURL(looseFile).href, 'MY_TEX2D(_LazyTex)');

    expect(workspace?.unityRoot).toBe(projectA);
    expect(workspace?.index.store.get(pathToFileURL(looseFile).href)?.symbols).toMatchObject([
      { name: '_LazyTex', kind: 'variable' },
    ]);
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

  it('persists a ready workspace before removing its folder routing', async () => {
    const standaloneFolder = await mkdtemp(join(tmpdir(), 'usn-remove-persist-'));
    const folderUri = pathToFileURL(standaloneFolder).href;
    const fileUri = pathToFileURL(join(standaloneFolder, 'Loose.hlsl')).href;
    const calls: string[] = [];
    const manager = new WorkspaceManager();
    vi.spyOn(Workspace.prototype, 'bootstrap').mockResolvedValue(undefined);
    vi.spyOn(Workspace.prototype, 'persist').mockImplementation(async function persist(this: Workspace) {
      calls.push(`persist:${this.folderUri}`);
      expect(manager.workspaceFor(fileUri)).toBe(this);
    });

    await manager.addFolder(folderUri, DEFAULT_SETTINGS, fakeConnection);
    await manager.removeFolder(folderUri);

    expect(calls).toEqual([`persist:${folderUri}`]);
    expect(manager.workspaceFor(fileUri)).toBeUndefined();
  });
});
