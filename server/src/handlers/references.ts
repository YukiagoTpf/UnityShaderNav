import type {
  Connection,
  Location,
  ReferenceParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerReferencesHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
    const resolveRequest = async (): Promise<Location[] | null> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return null;
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      if (!workspace) return null;

      return workspace.referencesAt({
        document,
        position: params.position,
        includeDeclaration: params.context.includeDeclaration,
      });
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
