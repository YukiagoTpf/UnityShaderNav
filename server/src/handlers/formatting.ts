import type {
  Connection,
  DocumentFormattingParams,
  TextEdit,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerDocumentFormattingHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentFormatting(createDocumentRequestHandler<
    DocumentFormattingParams,
    TextEdit[] | null
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    resolve: (params, { document, workspace }, cancellation) => (
      workspace.formatDocument({
        document,
        options: params.options,
        ...(cancellation ? { cancellation } : {}),
      })
    ),
  }));
}
