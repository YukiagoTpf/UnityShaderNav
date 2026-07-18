import type {
  Connection,
  SymbolInformation,
  WorkspaceSymbolParams,
  CancellationToken,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { IndexedWorkspaceService } from '../workspace/indexedWorkspace';

export function registerWorkspaceSymbolHandler(
  connection: Connection,
  manager: Pick<IndexedWorkspaceService, 'workspaceSymbols'>,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onWorkspaceSymbol(async (
    params: WorkspaceSymbolParams,
    cancellation: CancellationToken,
  ): Promise<SymbolInformation[] | null> => {
    const resolveRequest = async (): Promise<SymbolInformation[]> => {
      return cancellation
        ? manager.workspaceSymbols(params.query, cancellation)
        : manager.workspaceSymbols(params.query);
    };

    const result = suspender
      ? await suspender.run(resolveRequest, cancellation)
      : await resolveRequest();
    return result;
  });
}
