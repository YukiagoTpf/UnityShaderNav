import { describe, expect, it, vi } from 'vitest';
import { registerFileWatchers } from '../../src/lifecycle/fileWatcher';
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
        workspaceForOrCreateFile: vi.fn(),
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

  it('rebuilds all workspaces when git, project, or Package identity facts change', async () => {
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
      handler?.({ uri: 'file:///projectA/Packages/manifest.json', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);
      handler?.({ uri: 'file:///projectA/ProjectSettings/ProjectVersion.txt', type: 'changed' });
      await vi.advanceTimersByTimeAsync(501);
      handler?.({
        uri: 'file:///projectA/Packages/com.example.embedded/package.json',
        type: 'changed',
      });
      await vi.advanceTimersByTimeAsync(501);

      expect(workspace.rebuild).toHaveBeenCalledTimes(5);
      expect(workspace.applyChanges).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the serving revision visible while a watcher-triggered rebuild is pending', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((event: FileEvent) => void) | undefined;
      const rebuildStarted = deferred();
      const releaseRebuild = deferred();
      let publishedSymbol = 'BeforeRebuild';
      const workspace = {
        folderUri: 'file:///projectA',
        applyChanges: vi.fn(async () => {}),
        rebuild: vi.fn(async () => {
          rebuildStarted.resolve();
          await releaseRebuild.promise;
          publishedSymbol = 'AfterRebuild';
        }),
        workspaceSymbols: vi.fn((query: string) => (
          query === publishedSymbol ? [{ name: publishedSymbol }] : []
        )),
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
      vi.advanceTimersByTime(501);
      await rebuildStarted.promise;

      expect(workspace.rebuild).toHaveBeenCalledTimes(1);
      expect(workspace.workspaceSymbols('BeforeRebuild')).toHaveLength(1);
      expect(workspace.workspaceSymbols('AfterRebuild')).toEqual([]);

      releaseRebuild.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(workspace.workspaceSymbols('BeforeRebuild')).toEqual([]);
      expect(workspace.workspaceSymbols('AfterRebuild')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delegates open-document replay to Workspace without external routing', async () => {
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
        workspaceForOrCreateFile: vi.fn(),
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

      expect(calls).toEqual(['rebuild']);
      expect(workspace.updateDocument).not.toHaveBeenCalled();
      expect(manager.workspaceForOrCreateFile).not.toHaveBeenCalled();
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
        workspaceForOrCreateFile: vi.fn(),
        list: vi.fn(() => [workspace]),
      };
      const connection = {
        console: { log: vi.fn() },
        onNotification: vi.fn((_name: string, callback: (event: FileEvent) => void) => {
          handler = callback;
        }),
      };

      registerFileWatchers(connection as never, manager as never);
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
