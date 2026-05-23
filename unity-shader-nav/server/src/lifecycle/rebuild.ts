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

function settingsAffectIndex(previous: ExtensionSettings, next: ExtensionSettings): boolean {
  return previous.projectRoot !== next.projectRoot
    || JSON.stringify(previous.includeDirectories) !== JSON.stringify(next.includeDirectories)
    || JSON.stringify(previous.excludePatterns) !== JSON.stringify(next.excludePatterns)
    || JSON.stringify(previous.declarationMacros) !== JSON.stringify(next.declarationMacros);
}

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
  beforeRebuild?: (workspace: Workspace) => void | Promise<void>,
): Promise<void> {
  suspender?.suspend();
  try {
    for (const workspace of await manager.readyList()) {
      await beforeRebuild?.(workspace);
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

export async function applyScopedSettingsAndRebuild(
  connection: Connection,
  manager: WorkspaceManager,
  settingsForWorkspace: (folderUri: string) => ExtensionSettings | Promise<ExtensionSettings>,
  getOpenDocuments: OpenDocumentsProvider,
  suspender?: RebuildSuspender,
): Promise<void> {
  const workspaces = await manager.readyList();
  const updates = await Promise.all(workspaces.map(async (workspace) => {
    const settings = await settingsForWorkspace(workspace.folderUri);
    return {
      workspace,
      settings,
      rebuild: settingsAffectIndex(workspace.settings, settings),
    };
  }));

  if (!updates.some((update) => update.rebuild)) {
    for (const { workspace, settings } of updates) {
      workspace.settings = settings;
      workspace.table = new MacroPatternTable(settings.declarationMacros);
    }
    return;
  }

  suspender?.suspend();
  try {
    for (const { workspace, settings, rebuild } of updates) {
      workspace.settings = settings;
      workspace.table = new MacroPatternTable(settings.declarationMacros);
      if (rebuild) await workspace.rebuild(connection);
    }
    await reindexOpenDocuments(manager, getOpenDocuments);
  } finally {
    suspender?.release();
  }
}

export { reindexOpenDocuments };
