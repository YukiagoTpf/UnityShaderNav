import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConnection, createInitializeResult } from './connection';
import {
  INDEX_STATUS_REQUEST,
  INCLUDE_POINT_CONTEXT_CHANGED_NOTIFICATION,
  CSHARP_CURRENT_SOURCE_CHANGED_NOTIFICATION,
  VISUAL_LAB_STATE_CHANGED_NOTIFICATION,
  VARIANT_CONTEXT_CHANGED_NOTIFICATION,
  VARIANT_CONTEXT_REQUEST,
  type IndexStatusSnapshot,
  type IncludePointContextChangedParams,
  type CSharpCurrentSourceChangedParams,
  type VariantContext,
  type VariantContextChangedParams,
  type VariantContextParams,
  type VariantContextResult,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from './adapter/adapterRegistry';
import { CompilerEvidenceService } from './adapter/compilerEvidenceService';
import {
  WorkspaceAdapterCoordinator,
} from './adapter/workspaceAdapterCoordinator';
import {
  VisualLabSessionCoordinator,
} from './adapter/visualLabSessionCoordinator';
import { loadSettings, onSettingsChanged } from './config';
import { registerAdapterDiagnosticOverlay } from './handlers/adapterDiagnostics';
import { registerAdapterStatusHandler } from './handlers/adapterStatus';
import { registerCodeActionHandler } from './handlers/codeActions';
import { registerCodeLensHandler } from './handlers/codeLens';
import { registerColorHandlers } from './handlers/colors';
import { registerCompletionHandler } from './handlers/completion';
import { registerCompilerViewsHandler } from './handlers/compilerViews';
import { registerDefinitionHandler } from './handlers/definition';
import { registerDocumentHighlightHandler } from './handlers/documentHighlight';
import { registerDocumentSymbolHandler } from './handlers/documentSymbol';
import { registerDiagnosticsPublisher } from './handlers/diagnostics';
import { registerDocuments } from './handlers/documents';
import { registerHoverHandler } from './handlers/hover';
import { registerDocumentFormattingHandler } from './handlers/formatting';
import { registerInactiveRegionsHandler } from './handlers/inactiveRegions';
import { registerIncludePointContextsHandler } from './handlers/includePointContexts';
import { registerMaterialContextHandler } from './handlers/materialContext';
import { registerVariantKeywordsHandler } from './handlers/variantKeywords';
import { registerVariantComparisonHandler } from './handlers/variantComparison';
import { registerPortabilityReportHandler } from './handlers/portabilityReport';
import {
  registerPassExplanationHandler,
} from './handlers/passExplanation';
import { registerPropertyRenameHandler } from './handlers/propertyRename';
import { registerReferencesHandler } from './handlers/references';
import { registerRenameHandler } from './handlers/rename';
import { registerSemanticTokensHandler } from './handlers/semanticTokens';
import { registerSignatureHelpHandler } from './handlers/signatureHelp';
import { registerWorkspaceSymbolHandler } from './handlers/workspaceSymbol';
import { registerVisualLabHandlers } from './handlers/visualLab';
import { registerFileWatchers } from './lifecycle/fileWatcher';
import { applyScopedSettingsAndRebuild } from './lifecycle/rebuild';
import { RequestSuspender } from './lifecycle/requestSuspender';
import { initializeWorkspaceFolders } from './lifecycle/workspaceFolderCoordinator';
import { WorkspaceManager } from './workspace';
import { variantContextStore } from './workspace/variantContextStore';
import { includePointContextStore } from './workspace/includePointContextStore';
import { portabilityTargetStore } from './portability/targetStore';
import type { CancellationToken } from 'vscode-languageserver/node';
import { throwIfRequestCancelled } from './lifecycle/requestCancellation';
import { CSharpCurrentSourceClient } from './adapter/csharpCurrentSourceClient';
import {
  PassExplanationService,
  WorkspacePassExplanationProjector,
} from './explanation';

const connection = getConnection();
const adapterRegistry = new AdapterRegistry();
const workspaceAdapters = new WorkspaceAdapterCoordinator({
  reportError(message, error) {
    const detail = error instanceof Error ? error.message : String(error);
    connection.console.error(`[UnityShaderNav] ${message}: ${detail}`);
  },
});
const csharpCurrentSource = new CSharpCurrentSourceClient(connection);
const manager = new WorkspaceManager({
  adapterForFolder: (folderUri) => (
    workspaceAdapters.adapterForFolder(folderUri)
  ),
  csharpCurrentSource,
});
manager.onDidChangeWorkspaces((workspaces) => {
  workspaceAdapters.reconcile(workspaces.map((workspace) => ({
    folderUri: workspace.folderUri,
    unityRoot: workspace.unityRoot,
  })));
});
const visualLabSessions = new VisualLabSessionCoordinator({
  manager,
  adapters: workspaceAdapters,
  publish(params) {
    const reportFailure = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(
        `[UnityShaderNav] Visual Lab notification failed: ${message}`,
      );
    };
    try {
      void Promise.resolve(
        connection.sendNotification(
          VISUAL_LAB_STATE_CHANGED_NOTIFICATION,
          params,
        ),
      ).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  },
});
const suspender = new RequestSuspender({ timeoutMs: 5000 });
const passExplanation = new PassExplanationService(
  new WorkspacePassExplanationProjector({ workspace: manager }),
);
let compilerEvidence!: CompilerEvidenceService;
let globalStorageDir: string | undefined;

registerAdapterStatusHandler(connection, workspaceAdapters);
registerVisualLabHandlers(
  connection,
  (documentUri) => visualLabSessions.serviceFor(documentUri),
);
registerPassExplanationHandler(connection, passExplanation, suspender);

// Status remains queryable during the bounded cold-start request gate.
connection.onRequest(
  INDEX_STATUS_REQUEST,
  (_params, cancellation: CancellationToken): IndexStatusSnapshot => {
    throwIfRequestCancelled(cancellation);
    return manager.statusSnapshot();
  },
);

connection.onNotification(
  CSHARP_CURRENT_SOURCE_CHANGED_NOTIFICATION,
  (_params: CSharpCurrentSourceChangedParams) => {
    manager.requestDiagnosticsRefresh();
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
    visualLabSessions.markShaderContextChanged(params.textDocument.uri);
  },
);

connection.onNotification(
  INCLUDE_POINT_CONTEXT_CHANGED_NOTIFICATION,
  (params: IncludePointContextChangedParams) => {
    includePointContextStore.set(params.folderUri, params.selection);
    compilerEvidence.markContextChanged(
      params.folderUri,
      params.selection?.contextId,
    );
    visualLabSessions.markShaderContextChanged();
    manager.requestDiagnosticsRefresh();
    void Promise.resolve().then(
      () => connection.languages.semanticTokens.refresh(),
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(
        `[UnityShaderNav] semantic-token Context refresh failed: ${message}`,
      );
    });
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
  portabilityTargetStore.delete(document.uri);
});
const documents = documentRegistry.documents;
documents.onDidOpen(({ document }) => {
  visualLabSessions.markSourceChanged(document.uri);
});
documents.onDidChangeContent(({ document }) => {
  visualLabSessions.markSourceChanged(document.uri);
});
documents.onDidClose(({ document }) => {
  visualLabSessions.markSourceChanged(document.uri);
});
compilerEvidence = new CompilerEvidenceService({
  registry: adapterRegistry,
  selectedContextFor: (uri) => manager.selectedIncludePointContextFor(uri),
  sourceText: async (uri) => {
    const open = documentRegistry.snapshot(uri);
    if (open) return open.text;
    try {
      return await fs.readFile(fileURLToPath(uri), 'utf8');
    } catch {
      return undefined;
    }
  },
});
const adapterDiagnosticOverlay = registerAdapterDiagnosticOverlay(
  connection,
  documentRegistry,
  adapterRegistry,
  undefined,
  compilerEvidence,
);
registerCompilerViewsHandler(
  connection,
  documentRegistry,
  adapterRegistry,
  compilerEvidence,
  (profile) => adapterDiagnosticOverlay.selectProfile(profile),
);
registerDiagnosticsPublisher(
  connection,
  documentRegistry,
  manager,
  [adapterDiagnosticOverlay],
);
adapterRegistry.onDidChangeStatus(() => manager.requestDiagnosticsRefresh());
workspaceAdapters.onDidChangeStatus(() => manager.requestDiagnosticsRefresh());
workspaceAdapters.onDidChangeMaterialContext(() => {
  visualLabSessions.markSelectionChanged();
});
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
registerPropertyRenameHandler(connection, documentRegistry, manager, suspender);
registerInactiveRegionsHandler(
  connection,
  documents,
  manager,
  (uri) => loadSettings(connection, uri),
  suspender,
);
registerIncludePointContextsHandler(connection, manager, suspender);
registerMaterialContextHandler(connection, manager, workspaceAdapters, suspender);
registerVariantKeywordsHandler(connection, documents);
registerPortabilityReportHandler(
  connection,
  documentRegistry,
  manager,
  adapterRegistry,
  () => manager.requestDiagnosticsRefresh(),
  suspender,
);
registerCodeLensHandler(connection, documents);
registerVariantComparisonHandler(connection, documents, adapterRegistry);
registerFileWatchers(
  connection,
  manager,
  (event) => {
    adapterDiagnosticOverlay.handleFileEvent(event);
    compilerEvidence.markSourceChanged(
      event.uri,
      undefined,
      event.type === 'deleted',
    );
    visualLabSessions.markSourceChanged(event.uri);
  },
);

connection.onShutdown(async () => {
  try {
    await manager.persistAll();
  } finally {
    visualLabSessions.dispose();
    workspaceAdapters.dispose();
  }
});

connection.listen();
