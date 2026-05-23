import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { MacroPatternTable } from '../macros';
import type { Workspace } from '../workspace/workspace';
import type { WorkspaceManager } from '../workspace/workspaceManager';
import type { RequestSuspender } from './requestSuspender';

export interface OpenDocumentSnapshot {
  uri: string;
  getText(): string;
}

export type OpenDocumentsProvider = () => Iterable<OpenDocumentSnapshot>;

type RebuildSuspender = Pick<RequestSuspender, 'suspend' | 'release'>;

async function reindexOpenDocuments(
  manager: WorkspaceManager,
  getOpenDocuments: OpenDocumentsProvider,
): Promise<void> {
  for (const document of getOpenDocuments()) {
    const workspace = await manager.workspaceForOrCreateFile(document.uri);
    await workspace?.reindex(document.uri, document.getText());
  }
}

export async function rebuildWorkspacesWithOpenDocuments(
  connection: Connection,
  manager: WorkspaceManager,
  getOpenDocuments: OpenDocumentsProvider,
  suspender?: RebuildSuspender,
  beforeRebuild?: (workspace: Workspace) => void,
): Promise<void> {
  suspender?.suspend();
  try {
    for (const workspace of manager.list()) {
      beforeRebuild?.(workspace);
      await workspace.rebuild(connection);
    }
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
    (workspace) => {
      workspace.settings = settings;
      workspace.table = new MacroPatternTable(settings.declarationMacros);
    },
  );
}

export { reindexOpenDocuments };
