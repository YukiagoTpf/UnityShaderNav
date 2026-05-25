import type {
  Connection,
  DocumentHighlight,
  DocumentHighlightParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';

export function registerDocumentHighlightHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentHighlight(async (params: DocumentHighlightParams): Promise<DocumentHighlight[] | null> => {
    const resolveRequest = async (): Promise<DocumentHighlight[] | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      let index = workspace.store.get(params.textDocument.uri);
      if (!index && typeof workspace.reindex === 'function') {
        await workspace.reindex(document.uri, document.getText());
        index = workspace.store.get(params.textDocument.uri);
      }
      if (!index) return null;

      return null;
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
