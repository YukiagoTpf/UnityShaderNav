import type { Connection } from 'vscode-languageserver/node';
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
      const workspace = manager.workspaceFor(event.uri);
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
