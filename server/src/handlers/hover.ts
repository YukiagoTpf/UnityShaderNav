import type {
  Connection,
  Hover,
  HoverParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerHoverHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onHover(createDocumentRequestHandler<HoverParams, Hover | null>(
    documents,
    manager,
    suspender,
    {
      uri: (params) => params.textDocument.uri,
      neutral: () => null,
      resolve: (params, { document, workspace }, cancellation) => workspace.hoverAt({
        document,
        position: params.position,
        ...(cancellation ? { cancellation } : {}),
      }),
    },
  ));
}
