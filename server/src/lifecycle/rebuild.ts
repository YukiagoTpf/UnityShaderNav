import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import type { Workspace } from '../workspace/workspace';
import type { WorkspaceManager } from '../workspace/workspaceManager';
import type { RequestSuspender } from './requestSuspender';

export const openDocumentGenerationKey = '__unityShaderNavOpenGeneration' as const;

export interface OpenDocumentSnapshot {
  uri: string;
  version: number;
  [openDocumentGenerationKey]?: number;
  getText(): string;
}

export type OpenDocumentsProvider = () => Iterable<OpenDocumentSnapshot>;

type RebuildSuspender = Pick<RequestSuspender, 'suspend' | 'release'>;
type RebuildSettingsProvider = (
  workspace: Workspace,
) => ExtensionSettings | undefined | Promise<ExtensionSettings | undefined>;

async function reindexOpenDocuments(
  manager: WorkspaceManager,
  getOpenDocuments: OpenDocumentsProvider,
): Promise<void> {
  for (const document of getOpenDocuments()) {
    const uri = document.uri;
    const version = document.version;
    const generation = document[openDocumentGenerationKey] ?? document;
    const text = document.getText();
    const routed = typeof manager.workspaceFor === 'function'
      ? manager.workspaceFor(uri)
      : undefined;
    if (routed && typeof routed.canServe === 'function' && !routed.canServe()) continue;
    const workspace = await manager.workspaceForOrCreateFile(uri);
    await workspace?.index.reindex(uri, text, () =>
      Array.from(getOpenDocuments()).some((current) =>
        current.uri === uri
        && current.version === version
        && (current[openDocumentGenerationKey] ?? current) === generation,
      ),
    );
  }
}

export async function rebuildWorkspacesWithOpenDocuments(
  connection: Connection,
  manager: WorkspaceManager,
  getOpenDocuments: OpenDocumentsProvider,
  suspender?: RebuildSuspender,
  settingsForRebuild?: RebuildSettingsProvider,
): Promise<void> {
  suspender?.suspend();
  try {
    const workspaces = await manager.rebuildableList();
    await Promise.all(workspaces.map(async (workspace) => {
      try {
        const settings = await settingsForRebuild?.(workspace);
        if (settings) {
          await workspace.rebuild(connection, settings);
        } else {
          await workspace.rebuild(connection);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        connection.console.error(
          `[UnityShaderNav] rebuild failed for ${workspace.folderUri}: ${message}`,
        );
      }
    }));
    await reindexOpenDocuments(manager, getOpenDocuments);
  } finally {
    suspender?.release();
  }
}

export async function applySettingsAndRebuild(
  connection: Connection,
  manager: WorkspaceManager,
  settings: ExtensionSettings,
  getOpenDocuments: OpenDocumentsProvider,
  suspender?: RebuildSuspender,
): Promise<void> {
  manager.configure(settings, connection);
  await rebuildWorkspacesWithOpenDocuments(
    connection,
    manager,
    getOpenDocuments,
    suspender,
    () => settings,
  );
}

export async function applyScopedSettingsAndRebuild(
  connection: Connection,
  manager: WorkspaceManager,
  settingsForWorkspace: (folderUri: string) => ExtensionSettings | Promise<ExtensionSettings>,
  getOpenDocuments: OpenDocumentsProvider,
  suspender?: RebuildSuspender,
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
      .then(async (rebuilt) => {
        if (rebuilt) await reindexOpenDocuments(manager, getOpenDocuments);
      })
      .catch((error: unknown) => reportFailure(update.workspace, error));
  }

  const blocking = updates.filter((update) => !update.initiallyIndexing);
  if (blocking.length === 0) return;

  // The decision is intentionally made inside each Workspace queue, so the
  // caller cannot know whether a rebuild is required before execution. A
  // short suspension for every serving-root settings update is the smallest
  // honest boundary; no-op index updates do not restore document overlays.
  suspender?.suspend();
  try {
    const rebuilt = await Promise.all(blocking.map(reconfigure));
    if (rebuilt.some(Boolean)) {
      await reindexOpenDocuments(manager, getOpenDocuments);
    }
  } finally {
    suspender?.release();
  }
}

export { reindexOpenDocuments };
