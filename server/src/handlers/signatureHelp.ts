import type {
  Connection,
  SignatureHelp,
  SignatureHelpParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerSignatureHelpHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onSignatureHelp(createDocumentRequestHandler<
    SignatureHelpParams,
    SignatureHelp | null
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    resolve: (params, { document, workspace }, cancellation) => (
      workspace.signatureHelpAt({
        document,
        position: params.position,
        ...(cancellation ? { cancellation } : {}),
      })
    ),
  }));
}
