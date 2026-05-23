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
        readyWorkspaceFor: vi.fn(async () => workspace),
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

  it('waits for workspace readiness before applying incremental file changes', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const ready = deferred();
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
        readyWorkspaceFor: vi.fn(async () => {
          calls.push('readyWorkspaceFor');
          await ready.promise;
          calls.push('ready');
          return workspace;
        }),
        workspaceForOrCreateFile: vi.fn(async () => ({
          reindex: vi.fn(async () => {}),
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

      expect(calls).toEqual(['readyWorkspaceFor']);
      expect(workspace.applyChanges).not.toHaveBeenCalled();

      ready.resolve();
      await vi.runAllTimersAsync();

      expect(calls).toEqual(['readyWorkspaceFor', 'ready', 'applyChanges']);
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
        readyWorkspaceFor: vi.fn(async () => workspace),
        readyList: vi.fn(async () => [workspace]),
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
        readyWorkspaceFor: vi.fn(async () => workspace),
        readyList: vi.fn(async () => [workspace]),
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
        readyWorkspaceFor: vi.fn(async () => workspace),
        readyList: vi.fn(async () => [workspace]),
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
        rebuild: vi.fn(async () => {
          calls.push('rebuild');
        }),
      };
      const manager = {
        workspaceFor: vi.fn(() => workspace),
        readyWorkspaceFor: vi.fn(async () => workspace),
        readyList: vi.fn(async () => [workspace]),
        workspaceForOrCreateFile: vi.fn(async () => ({
          reindex: vi.fn(async () => {
            calls.push('reindex-open-doc');
          }),
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
        () => [{ uri: 'file:///projectA/Assets/Shaders/Main.shader', getText: () => 'float4 LiveOnly();' }],
      );
      handler?.({ uri: 'file:///projectA/.git/HEAD', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);

      expect(calls).toEqual(['suspend', 'rebuild', 'reindex-open-doc', 'release']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores open document overlays after incremental file changes', async () => {
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
        readyWorkspaceFor: vi.fn(async () => workspace),
        workspaceForOrCreateFile: vi.fn(async () => ({
          reindex: vi.fn(async () => {
            calls.push('reindex-open-doc');
          }),
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
        () => [{ uri: 'file:///projectA/Assets/Shaders/Main.shader', getText: () => 'float4 LiveOnly();' }],
      );
      handler?.({ uri: 'file:///projectA/Assets/Shaders/Main.shader', type: 'changed' });
      vi.advanceTimersByTime(501);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(calls).toEqual(['applyChanges', 'reindex-open-doc']);
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
});
