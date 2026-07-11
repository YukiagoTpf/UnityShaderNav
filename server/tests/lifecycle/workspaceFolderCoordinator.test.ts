import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import {
  initializeWorkspaceFolders,
  registerWorkspaceFolderCoordinator,
} from '../../src/lifecycle/workspaceFolderCoordinator';

interface FolderChange {
  added: Array<{ uri: string }>;
  removed: Array<{ uri: string }>;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function harness(
  loadSettings: (uri: string) => Promise<typeof DEFAULT_SETTINGS> = async () => DEFAULT_SETTINGS,
): {
  addFolder: ReturnType<typeof vi.fn>;
  removeFolder: ReturnType<typeof vi.fn>;
  emit(change: FolderChange): void;
  coordinator: ReturnType<typeof registerWorkspaceFolderCoordinator>;
} {
  let listener: ((change: FolderChange) => void) | undefined;
  const addFolder = vi.fn(async () => {});
  const removeFolder = vi.fn(async () => {});
  const connection = {
    console: { error: vi.fn() },
    workspace: {
      onDidChangeWorkspaceFolders: vi.fn((next: (change: FolderChange) => void) => {
        listener = next;
      }),
    },
  };
  const coordinator = registerWorkspaceFolderCoordinator({
    manager: { addFolder, removeFolder } as never,
    connection: connection as never,
    loadSettings,
  });

  expect(connection.workspace.onDidChangeWorkspaceFolders).toHaveBeenCalledTimes(1);
  return {
    addFolder,
    removeFolder,
    coordinator,
    emit(change) {
      if (!listener) throw new Error('workspace folder listener was not registered');
      listener(change);
    },
  };
}

describe('WorkspaceFolderCoordinator', () => {
  it('registers the listener before awaiting global settings or the folder snapshot', async () => {
    const settings = deferred<typeof DEFAULT_SETTINGS>();
    let listenerRegistered = false;
    const manager = {
      addFolder: vi.fn(async () => {}),
      removeFolder: vi.fn(async () => {}),
      configure: vi.fn(),
    };
    const connection = {
      console: { error: vi.fn() },
      workspace: {
        onDidChangeWorkspaceFolders: vi.fn(() => {
          listenerRegistered = true;
        }),
        getWorkspaceFolders: vi.fn(async () => []),
      },
    };

    const initializing = initializeWorkspaceFolders({
      manager: manager as never,
      connection: connection as never,
      loadSettings: async () => {
        expect(listenerRegistered).toBe(true);
        return settings.promise;
      },
    });
    await flushPromises();

    expect(listenerRegistered).toBe(true);
    expect(manager.configure).not.toHaveBeenCalled();
    settings.resolve(DEFAULT_SETTINGS);
    await initializing;
    expect(manager.configure).toHaveBeenCalledTimes(1);
  });

  it('reconciles buffered events with the initial snapshot', async () => {
    const test = harness();
    test.emit({
      removed: [{ uri: 'file:///A' }],
      added: [{ uri: 'file:///B' }],
    });

    await test.coordinator.initialize([{ uri: 'file:///A' }]);

    expect(test.addFolder).toHaveBeenCalledTimes(1);
    expect(test.addFolder).toHaveBeenCalledWith(
      'file:///B',
      DEFAULT_SETTINGS,
      expect.anything(),
      undefined,
    );
    expect(test.removeFolder).not.toHaveBeenCalled();
  });

  it('coalesces a duplicate snapshot and buffered add', async () => {
    const test = harness();
    test.emit({ removed: [], added: [{ uri: 'file:///A' }] });

    await test.coordinator.initialize([{ uri: 'file:///A' }]);

    expect(test.addFolder).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect an add whose scoped settings resolve after removal', async () => {
    const settings = deferred<typeof DEFAULT_SETTINGS>();
    const test = harness(async () => settings.promise);
    await test.coordinator.initialize([]);

    test.emit({ removed: [], added: [{ uri: 'file:///A' }] });
    await flushPromises();
    test.emit({ removed: [{ uri: 'file:///A' }], added: [] });
    settings.resolve(DEFAULT_SETTINGS);
    await flushPromises();

    expect(test.removeFolder).toHaveBeenCalledWith('file:///A');
    expect(test.addFolder).not.toHaveBeenCalled();
  });

  it('starts independent additions while one settings read is blocked', async () => {
    const slowSettings = deferred<typeof DEFAULT_SETTINGS>();
    const test = harness(async (uri) => (
      uri === 'file:///slow' ? slowSettings.promise : DEFAULT_SETTINGS
    ));
    await test.coordinator.initialize([]);

    test.emit({
      removed: [],
      added: [{ uri: 'file:///slow' }, { uri: 'file:///ready' }],
    });
    await flushPromises();

    expect(test.addFolder).toHaveBeenCalledTimes(1);
    expect(test.addFolder).toHaveBeenCalledWith(
      'file:///ready',
      DEFAULT_SETTINGS,
      expect.anything(),
      undefined,
    );

    slowSettings.resolve(DEFAULT_SETTINGS);
    await flushPromises();
    expect(test.addFolder).toHaveBeenCalledTimes(2);
  });
});
