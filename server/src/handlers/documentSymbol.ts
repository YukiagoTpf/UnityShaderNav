import type {
  Connection,
  DocumentSymbol,
  DocumentSymbolParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerDocumentSymbolHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentSymbol(createDocumentRequestHandler<
    DocumentSymbolParams,
    DocumentSymbol[] | null,
    true
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    allowClosedDocument: true,
    resolve: (_params, { uri, document, workspace }) => (
      workspace.documentSymbols({ uri, document })
    ),
  }));
}
