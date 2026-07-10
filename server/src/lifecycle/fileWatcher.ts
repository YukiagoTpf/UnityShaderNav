import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { Debouncer } from './debouncer';
import {
  rebuildWorkspacesWithOpenDocuments,
  reindexOpenDocuments,
  type OpenDocumentsProvider,
} from './rebuild';
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
  getOpenDocuments: OpenDocumentsProvider = () => [],
): void {
  const debouncer = new Debouncer<FileEvent>(
    { windowMs: 500, threshold: 20 },
    (batch, mode) => {
      void dispatchBatch(batch, mode === 'rebuild');
    },
  );

  async function dispatchBatch(batch: FileEvent[], thresholdExceeded: boolean): Promise<void> {
    const rebuild = thresholdExceeded || batch.some((event) => isRebuildTrigger(event.uri));
    if (rebuild) {
      connection.console.log('[UnityShaderNav] [rebuild] file lifecycle event triggered full workspace rebuild');
      await rebuildWorkspacesWithOpenDocuments(connection, manager, getOpenDocuments, suspender);
      return;
    }

    const groups = new Map<Workspace, FileEvent[]>();
    for (const event of batch) {
      const workspace = await manager.readyWorkspaceFor(event.uri);
      if (!workspace) continue;
      const events = groups.get(workspace) ?? [];
      events.push(event);
      groups.set(workspace, events);
    }

    for (const [workspace, events] of groups) {
      await workspace.applyChanges(events, connection);
    }
    await reindexOpenDocuments(manager, getOpenDocuments);
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
    for (const removed of event.removed) {
      await manager.removeFolder(removed.uri);
    }

    for (const added of event.added) {
      await manager.addFolder(
        added.uri,
        await loadSettings(added.uri),
        connection,
        globalStorageDir,
      );
    }
  } finally {
    suspender?.release();
  }
}
