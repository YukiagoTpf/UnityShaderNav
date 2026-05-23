import { getConnection, createInitializeResult } from './connection';
import { loadSettings, onSettingsChanged } from './config';
import { registerDefinitionHandler } from './handlers/definition';
import { registerDocuments } from './handlers/documents';
import { registerFileWatchers } from './lifecycle/fileWatcher';
import { RequestSuspender } from './lifecycle/requestSuspender';
import { MacroPatternTable } from './macros';
import { WorkspaceManager } from './workspace';

const connection = getConnection();
const manager = new WorkspaceManager();
const suspender = new RequestSuspender({ timeoutMs: 5000 });

connection.onInitialize(() => createInitializeResult());

const documents = registerDocuments(connection, manager);

connection.onInitialized(async () => {
  suspender.suspend();
  try {
    const settings = await loadSettings(connection);
    manager.configure(settings, connection);
    const folders = await connection.workspace.getWorkspaceFolders() ?? [];
    for (const folder of folders) {
      await manager.addFolder(folder.uri, settings, connection);
    }
    connection.sendNotification('unityShaderNav/mode', { mode: manager.mode() });

    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const removed of event.removed) manager.removeFolder(removed.uri);
      void (async () => {
        for (const added of event.added) {
          await manager.addFolder(added.uri, settings, connection);
        }
      })();
    });

    connection.console.log('[UnityShaderNav] server initialized');
  } finally {
    suspender.release();
  }
});

onSettingsChanged(connection, async (settings) => {
  manager.configure(settings, connection);
  for (const workspace of manager.list()) {
    workspace.settings = settings;
    workspace.table = new MacroPatternTable(settings.declarationMacros);
    await workspace.bootstrap(connection);
  }
  for (const doc of documents.all()) {
    await manager.workspaceFor(doc.uri)?.reindex(doc.uri, doc.getText());
  }
});

registerDefinitionHandler(connection, documents, manager, suspender);
registerFileWatchers(connection, manager, suspender);

connection.listen();
