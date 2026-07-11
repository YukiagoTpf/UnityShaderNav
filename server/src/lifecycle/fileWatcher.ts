import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { Debouncer } from './debouncer';
import { rebuildWorkspaces } from './rebuild';
import type { RequestSuspender } from './requestSuspender';
import type { FileEvent, Workspace } from '../workspace/workspace';
import type { WorkspaceManager } from '../workspace/workspaceManager';

const WATCHER_NOTIFICATION = 'unityShaderNav/fileChange';

interface WorkspaceFolderChange {
  added: Iterable<{ uri: string }>;
  removed: Iterable<{ uri: string }>;
}

interface WorkspaceFolderChangeDependencies {
  manager: Pick<WorkspaceManager, 'addFolder' | 'removeFolder'>;
  connection: Connection;
  loadSettings(scopeUri: string): ExtensionSettings | Promise<ExtensionSettings>;
  globalStorageDir?: string;
  suspender?: Pick<RequestSuspender, 'suspend' | 'release'>;
}

function isRebuildTrigger(uri: string): boolean {
  return uri.endsWith('/.git/HEAD') || uri.endsWith('/Packages/packages-lock.json');
}

export function registerFileWatchers(
  connection: Connection,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'suspend' | 'release'>,
): void {
  const debouncer = new Debouncer<FileEvent>(
    { windowMs: 500, threshold: 20 },
    (batch, mode) => {
      void dispatchBatch(batch, mode === 'rebuild').catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof connection.console?.error === 'function') {
          connection.console.error(`[UnityShaderNav] file lifecycle update failed: ${message}`);
        }
      });
    },
  );

  async function dispatchBatch(batch: FileEvent[], thresholdExceeded: boolean): Promise<void> {
    const rebuild = thresholdExceeded || batch.some((event) => isRebuildTrigger(event.uri));
    if (rebuild) {
      connection.console.log('[UnityShaderNav] [rebuild] file lifecycle event triggered full workspace rebuild');
      await rebuildWorkspaces(connection, manager, suspender);
      return;
    }

    const groups = new Map<Workspace, FileEvent[]>();
    for (const event of batch) {
      for (const workspace of manager.readyWorkspacesFor(event.uri)) {
        const events = groups.get(workspace) ?? [];
        events.push(event);
        groups.set(workspace, events);
      }
    }

    const failures: unknown[] = [];
    await Promise.all([...groups].map(async ([workspace, events]) => {
      try {
        await workspace.applyChanges(events, connection);
      } catch (error) {
        failures.push(error);
      }
    }));
    if (failures.length > 0) throw failures[0];
  }

  connection.onNotification(WATCHER_NOTIFICATION, (event: FileEvent) => {
    debouncer.push(event);
  });
}

export async function applyWorkspaceFolderChanges(
  event: WorkspaceFolderChange,
  {
    manager,
    connection,
    loadSettings,
    globalStorageDir,
    suspender,
  }: WorkspaceFolderChangeDependencies,
): Promise<void> {
  suspender?.suspend();
  try {
    await Promise.all(Array.from(event.removed, ({ uri }) => manager.removeFolder(uri)));

    await Promise.all(Array.from(event.added, async ({ uri }) => {
      await manager.addFolder(
        uri,
        await loadSettings(uri),
        connection,
        globalStorageDir,
      );
    }));
  } finally {
    suspender?.release();
  }
}
