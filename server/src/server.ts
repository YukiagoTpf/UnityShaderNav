import { getConnection, createInitializeResult } from './connection';
import {
  INDEX_STATUS_REQUEST,
  type IndexStatusSnapshot,
} from '@unity-shader-nav/shared';
import { loadSettings, onSettingsChanged } from './config';
import { registerCompletionHandler } from './handlers/completion';
import { registerDefinitionHandler } from './handlers/definition';
import { registerDocumentHighlightHandler } from './handlers/documentHighlight';
import { registerDocumentSymbolHandler } from './handlers/documentSymbol';
import { registerDocuments } from './handlers/documents';
import { registerHoverHandler } from './handlers/hover';
import { registerInactiveRegionsHandler } from './handlers/inactiveRegions';
import { registerReferencesHandler } from './handlers/references';
import { registerSemanticTokensHandler } from './handlers/semanticTokens';
import { registerSignatureHelpHandler } from './handlers/signatureHelp';
import { registerWorkspaceSymbolHandler } from './handlers/workspaceSymbol';
import { registerFileWatchers } from './lifecycle/fileWatcher';
import { applyScopedSettingsAndRebuild } from './lifecycle/rebuild';
import { RequestSuspender } from './lifecycle/requestSuspender';
import { initializeWorkspaceFolders } from './lifecycle/workspaceFolderCoordinator';
import { WorkspaceManager } from './workspace';

const connection = getConnection();
const manager = new WorkspaceManager();
const suspender = new RequestSuspender({ timeoutMs: 5000 });
let globalStorageDir: string | undefined;

// Status remains queryable during the bounded cold-start request gate.
connection.onRequest(
  INDEX_STATUS_REQUEST,
  (): IndexStatusSnapshot => manager.statusSnapshot(),
);

connection.onInitialize((params) => {
  const options = params.initializationOptions as { globalStorageDir?: unknown } | undefined;
  globalStorageDir = typeof options?.globalStorageDir === 'string'
    ? options.globalStorageDir
    : undefined;
  manager.configureRuntime(connection, globalStorageDir);
  return createInitializeResult();
});

const documentRegistry = registerDocuments(connection, manager);
const documents = documentRegistry.documents;
manager.configureSettingsResolver((scopeUri) => loadSettings(connection, scopeUri));

connection.onInitialized(async () => {
  suspender.suspend();
  let startupSuspensionReleased = false;
  try {
    const initializations = initializeWorkspaceFolders({
      manager,
      connection,
      loadSettings: (scopeUri) => loadSettings(connection, scopeUri),
      globalStorageDir,
      onInitializationsStarted() {
        // Root records now register independently as scoped settings arrive.
        // Do not let one slow bootstrap suspend requests for another ready root.
        suspender.release();
        startupSuspensionReleased = true;
      },
    });

    await initializations;

    connection.console.log('[UnityShaderNav] server initialized');
  } finally {
    if (!startupSuspensionReleased) suspender.release();
  }
});

onSettingsChanged(connection, async (settings) => {
  manager.configure(settings, connection, globalStorageDir);
  await applyScopedSettingsAndRebuild(
    connection,
    manager,
    (folderUri) => loadSettings(connection, folderUri),
  );
});

registerDefinitionHandler(connection, documentRegistry, manager, suspender);
registerHoverHandler(connection, documentRegistry, manager, suspender);
registerCompletionHandler(connection, documentRegistry, manager, suspender);
registerSignatureHelpHandler(connection, documentRegistry, manager, suspender);
registerDocumentHighlightHandler(connection, documentRegistry, manager, suspender);
registerDocumentSymbolHandler(connection, documentRegistry, manager, suspender);
registerWorkspaceSymbolHandler(connection, manager, suspender);
registerSemanticTokensHandler(connection, documentRegistry, manager, suspender);
registerReferencesHandler(
  connection,
  documentRegistry,
  manager,
  suspender,
);
registerInactiveRegionsHandler(
  connection,
  documents,
  manager,
  (uri) => loadSettings(connection, uri),
  suspender,
);
registerFileWatchers(connection, manager);

connection.onShutdown(async () => {
  await manager.persistAll();
});

connection.listen();
