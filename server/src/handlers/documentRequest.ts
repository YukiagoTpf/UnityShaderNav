import type { RequestSuspender } from '../lifecycle/requestSuspender';
import {
  workspaceForDocumentRequest,
  type IndexedDocumentRegistry,
  type IndexedDocumentSnapshot,
  type IndexedWorkspace,
  type IndexedWorkspaceRequestRouter,
} from '../workspace/indexedWorkspace';

type RequestDocument<AllowClosed extends boolean> = AllowClosed extends true
  ? IndexedDocumentSnapshot | undefined
  : IndexedDocumentSnapshot;

export interface DocumentRequestContext<AllowClosed extends boolean = false> {
  readonly uri: string;
  readonly document: RequestDocument<AllowClosed>;
  readonly workspace: IndexedWorkspace;
}

export interface DocumentRequestOptions<Params, Result, AllowClosed extends boolean = false> {
  readonly uri: (params: Params) => string;
  readonly neutral: () => Result;
  readonly allowClosedDocument?: AllowClosed;
  readonly resolve: (
    params: Params,
    context: DocumentRequestContext<AllowClosed>,
  ) => Result | Promise<Result>;
}

/**
 * Build one LSP adapter with stable snapshot, routing, suspension, and neutral
 * result semantics. Open-document requests may lazily recreate a current
 * session route; closed-document requests can opt into an existing serving
 * workspace without fabricating a document snapshot.
 */
export function createDocumentRequestHandler<
  Params,
  Result,
  AllowClosed extends boolean = false,
>(
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender: Pick<RequestSuspender, 'run'> | undefined,
  options: DocumentRequestOptions<Params, Result, AllowClosed>,
): (params: Params) => Promise<Result> {
  return async (params: Params): Promise<Result> => {
    const resolveRequest = async (): Promise<Result> => {
      const uri = options.uri(params);
      const document = documents.snapshot(uri);
      if (!document && !options.allowClosedDocument) return options.neutral();

      const workspace = document
        ? await workspaceForDocumentRequest(document, documents, manager)
        : manager.servingWorkspaceFor(uri);
      if (!workspace) return options.neutral();

      return options.resolve(params, {
        uri,
        document,
        workspace,
      } as DocumentRequestContext<AllowClosed>);
    };

    if (!suspender) return resolveRequest();
    return await suspender.run(resolveRequest) ?? options.neutral();
  };
}
