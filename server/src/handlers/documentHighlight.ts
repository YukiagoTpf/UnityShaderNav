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
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerDocumentHighlightHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentHighlight(async (
    params: DocumentHighlightParams,
  ): Promise<DocumentHighlight[] | null> => {
    const resolveRequest = async (): Promise<DocumentHighlight[] | null> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return null;
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      if (!workspace) return null;

      return workspace.highlightsAt({
        document,
        position: params.position,
      });
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
