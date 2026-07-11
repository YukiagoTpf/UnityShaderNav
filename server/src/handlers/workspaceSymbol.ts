import type {
  Connection,
  SymbolInformation,
  WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { IndexedWorkspaceService } from '../workspace/indexedWorkspace';

export function registerWorkspaceSymbolHandler(
  connection: Connection,
  manager: Pick<IndexedWorkspaceService, 'workspaceSymbols'>,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams): Promise<SymbolInformation[] | null> => {
    const resolveRequest = async (): Promise<SymbolInformation[]> => (
      manager.workspaceSymbols(params.query)
    );

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
