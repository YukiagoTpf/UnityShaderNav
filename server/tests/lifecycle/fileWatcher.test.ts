import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { applyWorkspaceFolderChanges, registerFileWatchers } from '../../src/lifecycle/fileWatcher';
import type { FileEvent } from '../../src/workspace/workspace';

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

describe('registerFileWatchers', () => {
  it('applies ordinary file changes incrementally after debounce', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {}),
        rebuild: vi.fn(async () => {}),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspacesFor: vi.fn(() => [workspace]),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((name: string, callback: (event: FileEvent) => void) => {
          expect(name).toBe('unityShaderNav/fileChange');
          handler = callback;
        }),
      };

      registerFileWatchers(connection as never, manager as never);
      handler?.({ uri: 'file:///projectA/Assets/Shaders/Common.hlsl', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);

      expect(workspace.applyChanges).toHaveBeenCalledWith(
        [{ uri: 'file:///projectA/Assets/Shaders/Common.hlsl', type: 'changed' }],
        connection,
      );
      expect(workspace.rebuild).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates every serving Workspace that owns a disk baseline for the file', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const parent = {
        folderUri: 'file:///project',
        applyChanges: vi.fn(async () => {}),
      };
      const child = {
        folderUri: 'file:///project/Nested',
        applyChanges: vi.fn(async () => {}),
      };
      const manager = {
        readyWorkspacesFor: vi.fn(() => [child, parent]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };
      const event: FileEvent = {
        uri: 'file:///project/Nested/Shared.hlsl',
        type: 'changed',
      };

      registerFileWatchers(connection as never, manager as never);
      handler?.(event);
      await vi.advanceTimersByTimeAsync(501);

      expect(child.applyChanges).toHaveBeenCalledWith([event], connection);
      expect(parent.applyChanges).toHaveBeenCalledWith([event], connection);
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the remaining disk owners when one Workspace rejects the event', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const failed = {
        applyChanges: vi.fn(async () => {
          throw new Error('child failed');
        }),
      };
      const healthy = { applyChanges: vi.fn(async () => {}) };
      const manager = {
        readyWorkspacesFor: vi.fn(() => [failed, healthy]),
      };
      const connection = {
        console: { log: vi.fn(), error: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };
      const event: FileEvent = { uri: 'file:///project/Shared.hlsl', type: 'changed' };

      registerFileWatchers(connection as never, manager as never);
      handler?.(event);
      await vi.advanceTimersByTimeAsync(501);

      expect(failed.applyChanges).toHaveBeenCalledWith([event], connection);
      expect(healthy.applyChanges).toHaveBeenCalledWith([event], connection);
      expect(connection.console.error).toHaveBeenCalledWith(
        '[UnityShaderNav] file lifecycle update failed: child failed',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips incremental file changes while the target root is not serving', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const calls: string[] = [];
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {
          calls.push('applyChanges');
        }),
        rebuild: vi.fn(async () => {}),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspacesFor: vi.fn(() => {
          calls.push('readyWorkspacesFor');
          return [];
        }),
        workspaceForOrCreateFile: vi.fn(async () => ({
          index: { reindex: vi.fn(async () => {}) },
        })),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };

      registerFileWatchers(connection as never, manager as never);
      handler?.({ uri: 'file:///projectA/Assets/Shaders/Common.hlsl', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);

      expect(calls).toEqual(['readyWorkspacesFor']);
      expect(workspace.applyChanges).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds all workspaces when the debounced batch exceeds threshold', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {}),
        rebuild: vi.fn(async () => {}),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspacesFor: vi.fn(() => [workspace]),
        rebuildableList: vi.fn(async () => [workspace]),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };

      registerFileWatchers(connection as never, manager as never);
      for (let i = 0; i < 21; i++) {
        handler?.({ uri: `file:///projectA/Assets/Shaders/${i}.hlsl`, type: 'changed' });
      }
      await vi.advanceTimersByTimeAsync(501);

      expect(workspace.rebuild).toHaveBeenCalledWith(connection);
      expect(workspace.applyChanges).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds all workspaces when git HEAD or packages-lock changes', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {}),
        rebuild: vi.fn(async () => {}),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspacesFor: vi.fn(() => [workspace]),
        rebuildableList: vi.fn(async () => [workspace]),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };

      registerFileWatchers(connection as never, manager as never);
      handler?.({ uri: 'file:///projectA/.git/HEAD', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);
      handler?.({ uri: 'file:///projectA/Packages/packages-lock.json', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);

      expect(workspace.rebuild).toHaveBeenCalledTimes(2);
      expect(workspace.applyChanges).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suspends requests while rebuilding and releases afterward', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {}),
        rebuild: vi.fn(async () => {}),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspacesFor: vi.fn(() => [workspace]),
        rebuildableList: vi.fn(async () => [workspace]),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };
      const suspender = {
        suspend: vi.fn(),
        release: vi.fn(),
      };

      registerFileWatchers(connection as never, manager as never, suspender);
      handler?.({ uri: 'file:///projectA/.git/HEAD', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);

      expect(suspender.suspend).toHaveBeenCalledTimes(1);
      expect(workspace.rebuild).toHaveBeenCalledTimes(1);
      expect(suspender.release).toHaveBeenCalledTimes(1);
      expect(suspender.suspend.mock.invocationCallOrder[0]).toBeLessThan(
        workspace.rebuild.mock.invocationCallOrder[0],
      );
      expect(suspender.release.mock.invocationCallOrder[0]).toBeGreaterThan(
        workspace.rebuild.mock.invocationCallOrder[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores open documents before releasing a rebuild suspension', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const calls: string[] = [];
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {}),
        updateDocument: vi.fn(async () => {
          calls.push('update-open-doc');
          return true;
        }),
        rebuild: vi.fn(async () => {
          calls.push('rebuild');
        }),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspacesFor: vi.fn(() => [workspace]),
        rebuildableList: vi.fn(async () => [workspace]),
        workspaceForOrCreateFile: vi.fn(async () => ({
          index: {
            reindex: vi.fn(async () => {
              calls.push('reindex-open-doc');
            }),
          },
        })),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };
      const suspender = {
        suspend: vi.fn(() => calls.push('suspend')),
        release: vi.fn(() => calls.push('release')),
      };

      registerFileWatchers(
        connection as never,
        manager as never,
        suspender,
      );
      handler?.({ uri: 'file:///projectA/.git/HEAD', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);

      expect(calls).toEqual(['suspend', 'rebuild', 'release']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delegates incremental overlay restoration to Workspace.applyChanges', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const calls: string[] = [];
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {
          calls.push('applyChanges');
        }),
        rebuild: vi.fn(async () => {}),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspacesFor: vi.fn(() => [workspace]),
        workspaceForOrCreateFile: vi.fn(async () => ({
          index: {
            reindex: vi.fn(async () => {
              calls.push('reindex-open-doc');
            }),
          },
        })),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };

      registerFileWatchers(
        connection as never,
        manager as never,
        undefined,
      );
      handler?.({ uri: 'file:///projectA/Assets/Shaders/Main.shader', type: 'changed' });
      vi.advanceTimersByTime(501);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(calls).toEqual(['applyChanges']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs incremental infrastructure failures after the workspace exposes them', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {
          throw new Error('parser engine panic');
        }),
      };
      const manager = {
        readyWorkspacesFor: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn(), error: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };

      registerFileWatchers(connection as never, manager as never);
      handler?.({ uri: 'file:///projectA/Assets/Shaders/Broken.hlsl', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);

      expect(connection.console.error).toHaveBeenCalledWith(
        '[UnityShaderNav] file lifecycle update failed: parser engine panic',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('applyWorkspaceFolderChanges', () => {
  it('suspends requests until folder removals and additions complete', async () => {
    const calls: string[] = [];
    const manager = {
      removeFolder: vi.fn(async () => {
        calls.push('removeFolder');
      }),
      addFolder: vi.fn(async () => {
        calls.push('addFolder');
      }),
    };
    const suspender = {
      suspend: vi.fn(() => calls.push('suspend')),
      release: vi.fn(() => calls.push('release')),
    };

    await applyWorkspaceFolderChanges(
      {
        removed: [{ uri: 'file:///removed' }],
        added: [{ uri: 'file:///added' }],
      },
      {
        manager: manager as never,
        connection: {} as never,
        loadSettings: async () => DEFAULT_SETTINGS,
        suspender,
      },
    );

    expect(calls).toEqual(['suspend', 'removeFolder', 'addFolder', 'release']);
    expect(manager.removeFolder).toHaveBeenCalledWith('file:///removed');
    expect(manager.addFolder).toHaveBeenCalledWith(
      'file:///added',
      DEFAULT_SETTINGS,
      {},
      undefined,
    );
  });

  it('releases request suspension when adding a folder fails', async () => {
    const manager = {
      removeFolder: vi.fn(async () => {}),
      addFolder: vi.fn(async () => {
        throw new Error('bootstrap failed');
      }),
    };
    const suspender = {
      suspend: vi.fn(),
      release: vi.fn(),
    };

    await expect(applyWorkspaceFolderChanges(
      {
        removed: [],
        added: [{ uri: 'file:///added' }],
      },
      {
        manager: manager as never,
        connection: {} as never,
        loadSettings: async () => DEFAULT_SETTINGS,
        suspender,
      },
    )).rejects.toThrow('bootstrap failed');

    expect(suspender.suspend).toHaveBeenCalledTimes(1);
    expect(suspender.release).toHaveBeenCalledTimes(1);
  });

  it('starts additions independently after the removal phase', async () => {
    const slowSettings = deferred<typeof DEFAULT_SETTINGS>();
    const manager = {
      removeFolder: vi.fn(async () => {}),
      addFolder: vi.fn(async () => {}),
    };

    const applying = applyWorkspaceFolderChanges(
      {
        removed: [],
        added: [{ uri: 'file:///slow' }, { uri: 'file:///ready' }],
      },
      {
        manager: manager as never,
        connection: {} as never,
        loadSettings: async (uri) => (
          uri === 'file:///slow' ? slowSettings.promise : DEFAULT_SETTINGS
        ),
      },
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(manager.addFolder).toHaveBeenCalledTimes(1);
    expect(manager.addFolder).toHaveBeenCalledWith(
      'file:///ready',
      DEFAULT_SETTINGS,
      {},
      undefined,
    );

    slowSettings.resolve(DEFAULT_SETTINGS);
    await applying;
    expect(manager.addFolder).toHaveBeenCalledTimes(2);
  });
});
