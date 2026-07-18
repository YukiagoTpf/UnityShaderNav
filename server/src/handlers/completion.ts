import type {
  CompletionItem,
  CompletionParams,
  Connection,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerCompletionHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onCompletion(createDocumentRequestHandler<
    CompletionParams,
    CompletionItem[] | null
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    resolve: (params, { document, workspace }, cancellation) => (
      workspace.completionAt({
        document,
        position: params.position,
        ...(cancellation ? { cancellation } : {}),
      })
    ),
  }));
}
