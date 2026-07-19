import type {
  Connection,
  SymbolInformation,
  WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { IndexedWorkspaceService } from '../workspace/indexedWorkspace';
import { createRequestHandler } from './documentRequest';

export function registerWorkspaceSymbolHandler(
  connection: Connection,
  manager: Pick<IndexedWorkspaceService, 'workspaceSymbols'>,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onWorkspaceSymbol(createRequestHandler<
    WorkspaceSymbolParams,
    SymbolInformation[]
  >(suspender, {
    neutral: () => [],
    resolve: (params, cancellation) => {
      return cancellation
        ? manager.workspaceSymbols(params.query, cancellation)
        : manager.workspaceSymbols(params.query);
    },
  }));
}
