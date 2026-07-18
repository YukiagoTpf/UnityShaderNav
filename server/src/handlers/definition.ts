import type {
  Connection,
  DefinitionParams,
  Location,
  LocationLink,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

export function registerDefinitionHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDefinition(createDocumentRequestHandler<
    DefinitionParams,
    LocationLink[] | Location[] | null
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    resolve: (params, { document, workspace }, cancellation) => (
      workspace.definitionAt({
        document,
        position: params.position,
        ...(cancellation ? { cancellation } : {}),
        observer: {
          trace(event, data) {
            connection.console.log(
              `[UnityShaderNav][definition-trace] ${event} ${JSON.stringify(data)}`,
            );
          },
          caseInsensitiveInclude(includePath, absolutePath) {
            connection.console.warn(
              `[UnityShaderNav] case-insensitive include match: "${includePath}" -> ${absolutePath}`,
            );
          },
        },
      })
    ),
  }));
}
