import {
  LSPErrorCodes,
  ResponseError,
  type Connection,
  type PrepareRenameParams,
  type Range,
  type RenameParams,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import {
  isRenameFailure,
  type IndexedDocumentRegistry,
  type IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';
import { createDocumentRequestHandler } from './documentRequest';

type PrepareResult = Range | { range: Range; placeholder: string } | null;

export function registerRenameHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onPrepareRename(createDocumentRequestHandler<
    PrepareRenameParams,
    PrepareResult
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    resolve: async (params, { document, workspace }, cancellation) => {
      const outcome = await workspace.prepareRenameAt({
        document,
        position: params.position,
        ...(cancellation ? { cancellation } : {}),
      });
      if (isRenameFailure(outcome)) {
        throw new ResponseError(LSPErrorCodes.RequestFailed, outcome.message);
      }
      return outcome
        ? { range: outcome.range, placeholder: outcome.placeholder }
        : null;
    },
  }));

  connection.onRenameRequest(createDocumentRequestHandler<
    RenameParams,
    WorkspaceEdit | null
  >(documents, manager, suspender, {
    uri: (params) => params.textDocument.uri,
    neutral: () => null,
    resolve: async (params, { document, workspace }, cancellation) => {
      const outcome = await workspace.renameAt({
        document,
        position: params.position,
        newName: params.newName,
        ...(cancellation ? { cancellation } : {}),
      });
      if (isRenameFailure(outcome)) {
        throw new ResponseError(LSPErrorCodes.RequestFailed, outcome.message);
      }
      return outcome;
    },
  }));
}
