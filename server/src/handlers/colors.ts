import type {
  ColorInformation,
  ColorPresentation,
  ColorPresentationParams,
  Connection,
  DocumentColorParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerColorHandlers(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentColor(async (params: DocumentColorParams): Promise<ColorInformation[]> => {
    const request = async (): Promise<ColorInformation[]> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return [];
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      return workspace?.documentColors({ uri: document.uri, document }) ?? [];
    };
    return suspender ? await suspender.run(request) ?? [] : request();
  });

  connection.onColorPresentation(async (
    params: ColorPresentationParams,
  ): Promise<ColorPresentation[]> => {
    const request = async (): Promise<ColorPresentation[]> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return [];
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      return workspace?.colorPresentations({
        document,
        range: params.range,
        color: params.color,
      }) ?? [];
    };
    return suspender ? await suspender.run(request) ?? [] : request();
  });
}
