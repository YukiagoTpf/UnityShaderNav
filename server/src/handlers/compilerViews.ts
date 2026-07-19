import type { Connection } from 'vscode-languageserver/node';
import {
  COMPILER_MAPPING_REQUEST,
  COMPILER_PROFILES_REQUEST,
  COMPILER_VIEWS_REQUEST,
  COMPILER_VIRTUAL_DOCUMENT_CHANGED_NOTIFICATION,
  COMPILER_VIRTUAL_DOCUMENT_REQUEST,
  type CompileProfile,
  type CompileProfileDiscovery,
  type CompilerMappingParams,
  type CompilerMappingResult,
  type CompilerProfilesParams,
  type CompilerViewsParams,
  type CompilerViewsResult,
  type CompilerVirtualDocumentChangedParams,
  type CompilerVirtualDocumentParams,
  type CompilerVirtualDocumentResult,
} from '@unity-shader-nav/shared';
import type { AdapterRegistry } from '../adapter/adapterRegistry';
import type { CompilerEvidenceService } from '../adapter/compilerEvidenceService';
import type { RegisteredDocuments } from './documents';

/** Register the pull-only virtual document and bidirectional mapping surface. */
export function registerCompilerViewsHandler(
  connection: Connection,
  documents: RegisteredDocuments,
  registry: AdapterRegistry,
  evidence: CompilerEvidenceService,
  selectProfile: (profile: CompileProfile) => void,
): void {
  evidence.onDidChange((uris) => {
    void Promise.resolve(connection.sendNotification(
      COMPILER_VIRTUAL_DOCUMENT_CHANGED_NOTIFICATION,
      { uris } satisfies CompilerVirtualDocumentChangedParams,
    )).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      connection.console.error(
        `[UnityShaderNav] compiler virtual document refresh failed: ${message}`,
      );
    });
  });

  documents.documents.onDidOpen(({ document }) => {
    evidence.markSourceChanged(document.uri, document.getText());
  });
  documents.documents.onDidChangeContent(({ document }) => {
    evidence.markSourceChanged(document.uri, document.getText());
  });

  connection.onRequest(
    COMPILER_PROFILES_REQUEST,
    (_params: CompilerProfilesParams): Promise<CompileProfileDiscovery> => (
      registry.compileProfiles()
    ),
  );
  connection.onRequest(
    COMPILER_VIEWS_REQUEST,
    async (params: CompilerViewsParams): Promise<CompilerViewsResult> => {
      const result = await evidence.viewsFor(params.textDocument.uri, params.profile);
      if (result.status === 'available' && !result.stale) {
        selectProfile(result.profile);
      }
      return result;
    },
  );
  connection.onRequest(
    COMPILER_VIRTUAL_DOCUMENT_REQUEST,
    (params: CompilerVirtualDocumentParams): CompilerVirtualDocumentResult => (
      evidence.virtualDocument(params.uri)
    ),
  );
  connection.onRequest(
    COMPILER_MAPPING_REQUEST,
    (params: CompilerMappingParams): CompilerMappingResult => evidence.map(params),
  );
}
