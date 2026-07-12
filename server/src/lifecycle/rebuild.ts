import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import type { Workspace } from '../workspace/workspace';
import type { WorkspaceManager } from '../workspace/workspaceManager';

export async function rebuildWorkspaces(
  connection: Connection,
  manager: WorkspaceManager,
): Promise<void> {
  const workspaces = await manager.rebuildableList();
  await Promise.all(workspaces.map(async (workspace) => {
    try {
      await workspace.rebuild(connection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(
        `[UnityShaderNav] rebuild failed for ${workspace.folderUri}: ${message}`,
      );
    }
  }));
}

export async function applyScopedSettingsAndRebuild(
  connection: Connection,
  manager: WorkspaceManager,
  settingsForWorkspace: (folderUri: string) => ExtensionSettings | Promise<ExtensionSettings>,
): Promise<void> {
  const updates = await Promise.all(manager.list().map(async (workspace) => {
    const settings = await settingsForWorkspace(workspace.folderUri);
    const lifecycle = workspace.indexStatus().lifecycle;
    return {
      workspace,
      settings,
      initiallyIndexing: lifecycle.state === 'indexing' && lifecycle.operation === 'initial',
    };
  }));

  const reportFailure = (workspace: Workspace, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(
      `[UnityShaderNav] settings update failed for ${workspace.folderUri}: ${message}`,
    );
  };
  const reconfigure = async (
    { workspace, settings }: (typeof updates)[number],
  ): Promise<boolean> => {
    try {
      return await workspace.reconfigure(connection, settings);
    } catch (error) {
      reportFailure(workspace, error);
      return false;
    }
  };

  const deferred = updates.filter((update) => update.initiallyIndexing);
  for (const update of deferred) {
    void reconfigure(update)
      .catch((error: unknown) => reportFailure(update.workspace, error));
  }

  const blocking = updates.filter((update) => !update.initiallyIndexing);
  if (blocking.length === 0) return;

  // Serving roots retain an immutable revision while their candidate builds;
  // suspending requests here would defeat that contract.
  await Promise.all(blocking.map(reconfigure));
}
