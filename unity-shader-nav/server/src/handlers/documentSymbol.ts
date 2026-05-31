import type {
  Connection,
  DocumentSymbol,
  DocumentSymbolParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { buildDocumentSymbols } from '../index/documentSymbols';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';

export function registerDocumentSymbolHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<DocumentSymbol[] | null> => {
    const resolveRequest = async (): Promise<DocumentSymbol[] | null> => {
      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      let index = workspace.index.store.get(params.textDocument.uri);
      if (!index) {
        const document = documents.get(params.textDocument.uri);
        if (document) {
          await workspace.index.reindex(document.uri, document.getText());
          index = workspace.index.store.get(params.textDocument.uri);
        }
      }
      if (!index) return null;

      return buildDocumentSymbols(index);
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
