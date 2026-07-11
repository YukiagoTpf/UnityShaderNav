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
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerDefinitionHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDefinition(async (params: DefinitionParams): Promise<LocationLink[] | Location[] | null> => {
    const resolveRequest = async (): Promise<LocationLink[] | Location[] | null> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return null;
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      if (!workspace) return null;

      return workspace.definitionAt({
        document,
        position: params.position,
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
      });
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
