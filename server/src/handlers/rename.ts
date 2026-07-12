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
  workspaceForDocumentRequest,
  type IndexedDocumentRegistry,
  type IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';

type PrepareResult = Range | { range: Range; placeholder: string } | null;

export function registerRenameHandler(
  connection: Connection,
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  const workspaceFor = async (uri: string) => {
    const document = documents.snapshot(uri);
    if (!document) return undefined;
    const workspace = await workspaceForDocumentRequest(document, documents, manager);
    return workspace ? { document, workspace } : undefined;
  };

  connection.onPrepareRename(async (params: PrepareRenameParams): Promise<PrepareResult> => {
    const resolveRequest = async (): Promise<PrepareResult> => {
      const context = await workspaceFor(params.textDocument.uri);
      if (!context) return null;
      const outcome = await context.workspace.prepareRenameAt({
        document: context.document,
        position: params.position,
      });
      if (isRenameFailure(outcome)) {
        throw new ResponseError(LSPErrorCodes.RequestFailed, outcome.message);
      }
      return outcome
        ? { range: outcome.range, placeholder: outcome.placeholder }
        : null;
    };
    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });

  connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | null> => {
    const resolveRequest = async (): Promise<WorkspaceEdit | null> => {
      const context = await workspaceFor(params.textDocument.uri);
      if (!context) return null;
      const outcome = await context.workspace.renameAt({
        document: context.document,
        position: params.position,
        newName: params.newName,
      });
      if (isRenameFailure(outcome)) {
        throw new ResponseError(LSPErrorCodes.RequestFailed, outcome.message);
      }
      return outcome;
    };
    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
