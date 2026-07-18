import type {
  CodeAction,
  CodeActionParams,
  Connection,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import {
  type IndexedDocumentRegistry,
  type IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerCodeActionHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onCodeAction(createDocumentRequestHandler<CodeActionParams, CodeAction[]>(
    documents,
    manager,
    suspender,
    {
      uri: (params) => params.textDocument.uri,
      neutral: () => [],
      resolve: (params, { document, workspace }) => workspace.codeActionsAt({
        document,
        range: params.range,
        context: params.context,
      }),
    },
  ));
}
