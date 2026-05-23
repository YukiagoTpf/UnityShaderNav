import { getConnection, createInitializeResult } from './connection';
import { loadSettings, onSettingsChanged } from './config';
import { registerDefinitionHandler } from './handlers/definition';
import { registerDocumentSymbolHandler } from './handlers/documentSymbol';
import { registerDocuments } from './handlers/documents';
import { registerFileWatchers } from './lifecycle/fileWatcher';
import { applyScopedSettingsAndRebuild, reindexOpenDocuments } from './lifecycle/rebuild';
import { RequestSuspender } from './lifecycle/requestSuspender';
import { WorkspaceManager } from './workspace';

const connection = getConnection();
const manager = new WorkspaceManager();
const suspender = new RequestSuspender({ timeoutMs: 5000 });
let globalStorageDir: string | undefined;

connection.onInitialize((params) => {
  const options = params.initializationOptions as { globalStorageDir?: unknown } | undefined;
  globalStorageDir = typeof options?.globalStorageDir === 'string'
    ? options.globalStorageDir
    : undefined;
  return createInitializeResult();
});

const documents = registerDocuments(connection, manager);
const openDocuments = () => documents.all();
manager.configureSettingsResolver((scopeUri) => loadSettings(connection, scopeUri));

connection.onInitialized(async () => {
  suspender.suspend();
  try {
    const settings = await loadSettings(connection);
    manager.configure(settings, connection, globalStorageDir);
    const folders = await connection.workspace.getWorkspaceFolders() ?? [];
    for (const folder of folders) {
      await manager.addFolder(
        folder.uri,
        await loadSettings(connection, folder.uri),
        connection,
        globalStorageDir,
      );
    }
    await reindexOpenDocuments(manager, openDocuments);
    connection.sendNotification('unityShaderNav/mode', { mode: manager.mode() });

    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const removed of event.removed) manager.removeFolder(removed.uri);
      void (async () => {
        for (const added of event.added) {
          await manager.addFolder(
            added.uri,
            await loadSettings(connection, added.uri),
            connection,
            globalStorageDir,
          );
        }
      })();
    });

    connection.console.log('[UnityShaderNav] server initialized');
  } finally {
    suspender.release();
  }
});

onSettingsChanged(connection, async (settings) => {
  manager.configure(settings, connection, globalStorageDir);
  await applyScopedSettingsAndRebuild(
    connection,
    manager,
    (folderUri) => loadSettings(connection, folderUri),
    openDocuments,
    suspender,
  );
});

registerDefinitionHandler(connection, documents, manager, suspender);
registerDocumentSymbolHandler(connection, documents, manager, suspender);
registerFileWatchers(connection, manager, suspender, openDocuments);

connection.onShutdown(async () => {
  await manager.persistAll();
});

connection.listen();
