import type {
  Connection,
  SignatureHelp,
  SignatureHelpParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export function registerSignatureHelpHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onSignatureHelp(async (params: SignatureHelpParams): Promise<SignatureHelp | null> => {
    const resolveRequest = async (): Promise<SignatureHelp | null> => {
      const document = documents.snapshot(params.textDocument.uri);
      if (!document) return null;
      const workspace = await workspaceForDocumentRequest(document, documents, manager);
      if (!workspace) return null;

      return workspace.signatureHelpAt({
        document,
        position: params.position,
      });
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
