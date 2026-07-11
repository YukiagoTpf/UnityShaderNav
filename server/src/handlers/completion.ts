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
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerCompletionHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[] | null> => {
    const resolveRequest = async (): Promise<CompletionItem[] | null> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return null;
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      if (!workspace) return null;

      return workspace.completionAt({
        document,
        position: params.position,
      });
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
