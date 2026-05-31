import type {
  Connection,
  DocumentSymbol,
  DocumentSymbolParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { buildDocumentSymbols } from '../index/documentSymbols';
import { resolveRequestContext } from './requestContext';
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
      const ctx = await resolveRequestContext(params.textDocument.uri, documents, manager, { requireDocument: false });
      if (!ctx) return null;
      const index = await ctx.index();
      if (!index) return null;
      return buildDocumentSymbols(index);
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
