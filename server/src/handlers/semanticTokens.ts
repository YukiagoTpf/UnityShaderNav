import type {
  Connection,
  SemanticTokens,
  SemanticTokensParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export { SEMANTIC_TOKEN_TYPES } from '../workspace/semanticTokenLegend';

export function registerSemanticTokensHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.languages.semanticTokens.on(createDocumentRequestHandler<
    SemanticTokensParams,
    SemanticTokens,
    true
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => ({ data: [] }),
    allowClosedDocument: true,
    resolve: (_params, { uri, document, workspace }) => (
      workspace.semanticTokens({ uri, document })
    ),
  }));
}
