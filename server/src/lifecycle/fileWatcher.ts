import type { Connection } from 'vscode-languageserver/node';
import { Debouncer } from './debouncer';
import { rebuildWorkspaces } from './rebuild';
import type { FileEvent, Workspace } from '../workspace/workspace';
import type { WorkspaceManager } from '../workspace/workspaceManager';

const WATCHER_NOTIFICATION = 'unityShaderNav/fileChange';

function isRebuildTrigger(uri: string): boolean {
  return uri.endsWith('/.git/HEAD')
    || uri.endsWith('/Packages/packages-lock.json')
    || uri.endsWith('/Packages/manifest.json')
    || uri.endsWith('/ProjectSettings/ProjectVersion.txt')
    || /\/Packages\/[^/]+\/package\.json$/.test(uri);
}

export function registerFileWatchers(
  connection: Connection,
  manager: WorkspaceManager,
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
      await rebuildWorkspaces(connection, manager);
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
