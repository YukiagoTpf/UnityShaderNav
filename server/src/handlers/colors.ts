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
import { createDocumentRequestHandler } from './documentRequest';

export function registerColorHandlers(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDocumentColor(createDocumentRequestHandler<
    DocumentColorParams,
    ColorInformation[]
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => [],
    resolve: (_params, { uri, document, workspace }) => (
      workspace.documentColors({ uri, document })
    ),
  }));

  connection.onColorPresentation(createDocumentRequestHandler<
    ColorPresentationParams,
    ColorPresentation[]
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => [],
    resolve: (params, { document, workspace }) => (
      workspace.colorPresentations({
        document,
        range: params.range,
        color: params.color,
      })
    ),
  }));
}
