import type {
  CodeAction,
  CodeActionParams,
  Connection,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import {
  workspaceForDocumentRequest,
  type IndexedDocumentRegistry,
  type IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';

export function registerCodeActionHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[]> => {
    const resolveRequest = async (): Promise<CodeAction[]> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return [];
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      if (!workspace) return [];
      return workspace.codeActionsAt({
        document,
        range: params.range,
        context: params.context,
      });
    };
    return suspender ? await suspender.run(resolveRequest) ?? [] : resolveRequest();
  });
}
