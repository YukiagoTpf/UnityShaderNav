import type {
  Connection,
  DocumentFormattingParams,
  TextEdit,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerDocumentFormattingHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentFormatting(async (
    params: DocumentFormattingParams,
  ): Promise<TextEdit[] | null> => {
    const request = async (): Promise<TextEdit[] | null> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return null;
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      return workspace?.formatDocument({ document, options: params.options }) ?? null;
    };
    return suspender ? await suspender.run(request) ?? null : request();
  });
}
