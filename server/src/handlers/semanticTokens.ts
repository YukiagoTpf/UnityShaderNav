import type {
  Connection,
  SemanticTokens,
  SemanticTokensParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { workspaceForDocumentRequest } from '../workspace/indexedWorkspace';

export { SEMANTIC_TOKEN_TYPES } from '../workspace/semanticTokenLegend';

export function registerSemanticTokensHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.languages.semanticTokens.on(async (params: SemanticTokensParams): Promise<SemanticTokens> => {
    const resolveRequest = async (): Promise<SemanticTokens> => {
      const uri = params.textDocument.uri;
      const document = documents.snapshot(uri);
      const workspace = document
        ? await workspaceForDocumentRequest(document, documents, manager)
        : manager.servingWorkspaceFor(uri);
      if (!workspace) return { data: [] };

      return workspace.semanticTokens({ uri, document });
    };

    if (!suspender) return resolveRequest();
    return await suspender.run(resolveRequest) ?? { data: [] };
  });
}
