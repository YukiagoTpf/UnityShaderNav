import { getConnection, createInitializeResult } from './connection';
import {
  INDEX_STATUS_REQUEST,
  VARIANT_CONTEXT_CHANGED_NOTIFICATION,
  VARIANT_CONTEXT_REQUEST,
  type IndexStatusSnapshot,
  type VariantContext,
  type VariantContextChangedParams,
  type VariantContextParams,
  type VariantContextResult,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from './adapter/adapterRegistry';
import { loadSettings, onSettingsChanged } from './config';
import { registerAdapterStatusHandler } from './handlers/adapterStatus';
import { registerCodeActionHandler } from './handlers/codeActions';
import { registerCodeLensHandler } from './handlers/codeLens';
import { registerColorHandlers } from './handlers/colors';
import { registerCompletionHandler } from './handlers/completion';
import { registerDefinitionHandler } from './handlers/definition';
import { registerDocumentHighlightHandler } from './handlers/documentHighlight';
import { registerDocumentSymbolHandler } from './handlers/documentSymbol';
import { registerDiagnosticsPublisher } from './handlers/diagnostics';
import { registerDocuments } from './handlers/documents';
import { registerHoverHandler } from './handlers/hover';
import { registerDocumentFormattingHandler } from './handlers/formatting';
import { registerInactiveRegionsHandler } from './handlers/inactiveRegions';
import { registerVariantKeywordsHandler } from './handlers/variantKeywords';
import { registerReferencesHandler } from './handlers/references';
import { registerRenameHandler } from './handlers/rename';
import { registerSemanticTokensHandler } from './handlers/semanticTokens';
import { registerSignatureHelpHandler } from './handlers/signatureHelp';
import { registerWorkspaceSymbolHandler } from './handlers/workspaceSymbol';
import { registerFileWatchers } from './lifecycle/fileWatcher';
import { applyScopedSettingsAndRebuild } from './lifecycle/rebuild';
import { RequestSuspender } from './lifecycle/requestSuspender';
import { initializeWorkspaceFolders } from './lifecycle/workspaceFolderCoordinator';
import { WorkspaceManager } from './workspace';
import { variantContextStore } from './workspace/variantContextStore';
import type { CancellationToken } from 'vscode-languageserver/node';
import { throwIfRequestCancelled } from './lifecycle/requestCancellation';

const connection = getConnection();
const manager = new WorkspaceManager();
const adapterRegistry = new AdapterRegistry();
const suspender = new RequestSuspender({ timeoutMs: 5000 });
let globalStorageDir: string | undefined;

registerAdapterStatusHandler(connection, adapterRegistry);

// Status remains queryable during the bounded cold-start request gate.
connection.onRequest(
  INDEX_STATUS_REQUEST,
  (_params, cancellation: CancellationToken): IndexStatusSnapshot => {
    throwIfRequestCancelled(cancellation);
    return manager.statusSnapshot();
  },
);

connection.onNotification(
  VARIANT_CONTEXT_CHANGED_NOTIFICATION,
  (params: VariantContextChangedParams) => {
    // JSON-RPC serializes Set as {}, so the client sends activeKeywords as an
    // array; rebuild the Set for the in-memory domain type.
    const ctx = params.context
      ? { activeKeywords: new Set(params.context.activeKeywords) }
      : null;
    variantContextStore.set(params.textDocument.uri, ctx);
  },
);

connection.onRequest(
  VARIANT_CONTEXT_REQUEST,
  (params: VariantContextParams): VariantContextResult => {
    const stored = variantContextStore.get(params.textDocument.uri);
    // Send activeKeywords as an array over JSON-RPC (Set serializes to {}).
    return {
      context: stored
        ? { activeKeywords: [...stored.activeKeywords] } as unknown as VariantContext
        : null,
    };
  },
);

connection.onInitialize((params) => {
  const options = params.initializationOptions as { globalStorageDir?: unknown } | undefined;
  globalStorageDir = typeof options?.globalStorageDir === 'string'
    ? options.globalStorageDir
    : undefined;
  manager.configureRuntime(connection, globalStorageDir);
  return createInitializeResult(
    params.capabilities.textDocument?.rename?.prepareSupport === true,
  );
});

const documentRegistry = registerDocuments(connection, manager);
documentRegistry.onDidCloseSnapshot((document) => {
  variantContextStore.delete(document.uri);
});
const documents = documentRegistry.documents;
registerDiagnosticsPublisher(connection, documentRegistry, manager);
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
registerCodeActionHandler(connection, documentRegistry, manager, suspender);
registerHoverHandler(connection, documentRegistry, manager, suspender);
registerColorHandlers(connection, documentRegistry, manager, suspender);
registerDocumentFormattingHandler(connection, documentRegistry, manager, suspender);
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
registerRenameHandler(connection, documentRegistry, manager, suspender);
registerInactiveRegionsHandler(
  connection,
  documents,
  manager,
  (uri) => loadSettings(connection, uri),
  suspender,
);
registerVariantKeywordsHandler(connection, documents);
registerCodeLensHandler(connection, documents);
registerFileWatchers(connection, manager);

connection.onShutdown(async () => {
  await manager.persistAll();
});

connection.listen();
