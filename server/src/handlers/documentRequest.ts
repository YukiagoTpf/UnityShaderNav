import type { RequestSuspender } from '../lifecycle/requestSuspender';
import {
  awaitWithRequestCancellation,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import type { CancellationToken } from 'vscode-languageserver/node';
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

export interface RequestHandlerOptions<Params, Result> {
  readonly neutral: (params: Params) => Result;
  readonly resolve: (
    params: Params,
    cancellation: CancellationToken | undefined,
  ) => Result | Promise<Result>;
}

export interface DocumentRequestOptions<Params, Result, AllowClosed extends boolean = false> {
  readonly uri: (params: Params) => string;
  readonly neutral: (params: Params) => Result;
  readonly allowClosedDocument?: AllowClosed;
  readonly resolve: (
    params: Params,
    context: DocumentRequestContext<AllowClosed>,
    cancellation: CancellationToken | undefined,
  ) => Result | Promise<Result>;
}

/**
 * Build the common request boundary: cancellation wins over work completion,
 * startup suspension is transparent, and a timeout returns the endpoint's
 * parameter-aware neutral result.
 */
export function createRequestHandler<Params, Result>(
  suspender: Pick<RequestSuspender, 'run'> | undefined,
  options: RequestHandlerOptions<Params, Result>,
): (params: Params, cancellation?: CancellationToken) => Promise<Result> {
  return async (params: Params, cancellation?: CancellationToken): Promise<Result> => {
    throwIfRequestCancelled(cancellation);
    const resolveRequest = async (): Promise<Result> => {
      throwIfRequestCancelled(cancellation);
      const result = await awaitWithRequestCancellation(
        Promise.resolve(options.resolve(params, cancellation)),
        cancellation,
      );
      throwIfRequestCancelled(cancellation);
      return result;
    };

    if (!suspender) return resolveRequest();
    return await suspender.run(resolveRequest, cancellation) ?? options.neutral(params);
  };
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
): (params: Params, cancellation?: CancellationToken) => Promise<Result> {
  return createRequestHandler(suspender, {
    neutral: options.neutral,
    resolve: async (params, cancellation) => {
      const uri = options.uri(params);
      const document = documents.snapshot(uri);
      if (!document && !options.allowClosedDocument) return options.neutral(params);

      const workspace = document
        ? await workspaceForDocumentRequest(document, documents, manager)
        : manager.servingWorkspaceFor(uri);
      throwIfRequestCancelled(cancellation);
      if (!workspace) return options.neutral(params);

      return options.resolve(params, {
        uri,
        document,
        workspace,
      } as DocumentRequestContext<AllowClosed>, cancellation);
    },
  });
}
