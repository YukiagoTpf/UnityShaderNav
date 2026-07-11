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
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerDocumentSymbolHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<DocumentSymbol[] | null> => {
    const resolveRequest = async (): Promise<DocumentSymbol[] | null> => {
      const uri = params.textDocument.uri;
      const document = documents.snapshot(uri);
      const workspace = document
        ? await workspaceForDocumentRequest(document, documents, manager)
        : manager.servingWorkspaceFor(uri);
      if (!workspace) return null;

      return workspace.documentSymbols({ uri, document });
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
