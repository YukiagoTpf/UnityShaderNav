import type {
  Connection,
  DocumentHighlight,
  DocumentHighlightParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerDocumentHighlightHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentHighlight(createDocumentRequestHandler<
    DocumentHighlightParams,
    DocumentHighlight[] | null
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    resolve: (params, { document, workspace }, cancellation) => (
      workspace.highlightsAt({
        document,
        position: params.position,
        ...(cancellation ? { cancellation } : {}),
      })
    ),
  }));
}
