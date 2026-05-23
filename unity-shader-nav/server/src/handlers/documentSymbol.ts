import type {
  Connection,
  DocumentSymbol,
  DocumentSymbolParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { buildDocumentSymbols } from '../index/documentSymbols';
import type { WorkspaceManager } from '../workspace';

export function registerDocumentSymbolHandler(
  connection: Connection,
  _documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
): void {
  connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] | null => {
    const workspace = manager.workspaceFor(params.textDocument.uri);
    if (!workspace) return null;

    const index = workspace.store.get(params.textDocument.uri);
    if (!index) return null;

    return buildDocumentSymbols(index);
  });
}
