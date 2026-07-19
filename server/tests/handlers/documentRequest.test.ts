import { describe, expect, it, vi } from 'vitest';
import { LSPErrorCodes, ResponseError } from 'vscode-languageserver/node';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';
import {
  createDocumentRequestHandler,
  createRequestHandler,
} from '../../src/handlers/documentRequest';

const document: IndexedDocumentSnapshot = {
  uri: 'file:///Main.hlsl',
  languageId: 'hlsl',
  text: 'float4 Main();',
  openId: 3,
  version: 7,
};

const workspace = {} as IndexedWorkspace;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createRequestHandler', () => {
  it('maps suspension timeout to a parameter-aware neutral result', async () => {
    const resolve = vi.fn(async () => ({ request: 99 }));
    const handler = createRequestHandler(
      { run: async () => null },
      {
        neutral: (params: { request: number }) => params,
        resolve,
      },
    );

    await expect(handler({ request: 7 })).resolves.toEqual({ request: 7 });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('createDocumentRequestHandler', () => {
  it('reports RequestCancelled before snapshot routing for a pre-cancelled request', async () => {
    const cancellation = new CancellationTokenSource();
    cancellation.cancel();
    const documents = { snapshot: vi.fn(() => document) };
    const manager = { servingWorkspaceFor: vi.fn(() => workspace) };
    const resolve = vi.fn(async () => 'unexpected');
    const handler = createDocumentRequestHandler(documents, manager, undefined, {
      uri: (params: { uri: string }) => params.uri,
      neutral: () => 'neutral',
      resolve,
    });

    await expect(handler({ uri: document.uri }, cancellation.token))
      .rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    expect(documents.snapshot).not.toHaveBeenCalled();
    expect(manager.servingWorkspaceFor).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    cancellation.dispose();
  });

  it('detaches a cancelled waiter while lazy workspace routing continues', async () => {
    const route = deferred<IndexedWorkspace | undefined>();
    const cancellation = new CancellationTokenSource();
    const handler = createDocumentRequestHandler(
      { snapshot: () => document },
      {
        servingWorkspaceFor: () => undefined,
        workspaceFor: () => undefined,
        workspaceForOrCreateFile: () => route.promise,
      },
      undefined,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => 'neutral',
        resolve: async () => 'unexpected',
      },
    );
    let outcome: unknown;
    const request = handler({ uri: document.uri }, cancellation.token)
      .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });

    cancellation.cancel();
    await nextMacrotask();

    const outcomeBeforeRouteCompletes = outcome;
    route.resolve(workspace);
    await Promise.all([request, route.promise]);
    expect(outcomeBeforeRouteCompletes)
      .toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    cancellation.dispose();
  });

  it('detaches a cancelled waiter while an async workspace query continues', async () => {
    const query = deferred<string>();
    const queryStarted = deferred<void>();
    const cancellation = new CancellationTokenSource();
    const handler = createDocumentRequestHandler(
      { snapshot: () => document },
      { servingWorkspaceFor: () => workspace },
      undefined,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => 'neutral',
        resolve: () => {
          queryStarted.resolve();
          return query.promise;
        },
      },
    );
    let outcome: unknown;
    const request = handler({ uri: document.uri }, cancellation.token)
      .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });

    await queryStarted.promise;
    cancellation.cancel();
    await nextMacrotask();

    const outcomeBeforeQueryCompletes = outcome;
    query.resolve('late result');
    await Promise.all([request, query.promise]);
    expect(outcomeBeforeQueryCompletes)
      .toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    cancellation.dispose();
  });

  it('rejects cancellation delivered after the workspace query settles', async () => {
    const query = deferred<string>();
    const queryStarted = deferred<void>();
    const cancellation = new CancellationTokenSource();
    const handler = createDocumentRequestHandler(
      { snapshot: () => document },
      { servingWorkspaceFor: () => workspace },
      undefined,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => 'neutral',
        resolve: () => {
          queryStarted.resolve();
          return query.promise;
        },
      },
    );

    const request = handler({ uri: document.uri }, cancellation.token);
    await queryStarted.promise;
    const cancelAfterQuery = query.promise.then(() => cancellation.cancel());
    query.resolve('completed result');

    await cancelAfterQuery;
    await expect(request).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    cancellation.dispose();
  });

  it('captures an open snapshot, routes it, and resolves the request', async () => {
    const documents = { snapshot: vi.fn(() => document) };
    const manager = { servingWorkspaceFor: vi.fn(() => workspace) };
    const resolve = vi.fn(async (_params: { textDocument: { uri: string } }, context) => (
      `${context.document.version}:${context.workspace === workspace}`
    ));
    const handler = createDocumentRequestHandler(documents, manager, undefined, {
      uri: (params: { textDocument: { uri: string } }) => params.textDocument.uri,
      neutral: () => 'neutral',
      resolve,
    });

    await expect(handler({ textDocument: { uri: document.uri } }))
      .resolves.toBe('7:true');
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('returns the endpoint neutral without routing when no open snapshot exists', async () => {
    const manager = { servingWorkspaceFor: vi.fn(() => workspace) };
    const handler = createDocumentRequestHandler(
      { snapshot: () => undefined },
      manager,
      undefined,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => [] as string[],
        resolve: async () => ['unexpected'],
      },
    );

    await expect(handler({ uri: document.uri })).resolves.toEqual([]);
    expect(manager.servingWorkspaceFor).not.toHaveBeenCalled();
  });

  it('can route a closed document to an existing serving workspace', async () => {
    const manager = { servingWorkspaceFor: vi.fn(() => workspace) };
    const handler = createDocumentRequestHandler(
      { snapshot: () => undefined },
      manager,
      undefined,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => 'neutral',
        allowClosedDocument: true,
        resolve: async (_params, context) => (
          context.document === undefined && context.workspace === workspace
            ? 'closed'
            : 'unexpected'
        ),
      },
    );

    await expect(handler({ uri: document.uri })).resolves.toBe('closed');
    expect(manager.servingWorkspaceFor).toHaveBeenCalledWith(document.uri);
  });

  it('maps a suspended timeout to a fresh endpoint neutral', async () => {
    let neutralCount = 0;
    const handler = createDocumentRequestHandler(
      { snapshot: () => document },
      { servingWorkspaceFor: () => workspace },
      { run: async () => null },
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => ({ request: ++neutralCount }),
        resolve: async () => ({ request: 99 }),
      },
    );

    await expect(handler({ uri: document.uri })).resolves.toEqual({ request: 1 });
  });

  it('propagates the same request failure before and after startup suspension', async () => {
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    const failure = new ResponseError(LSPErrorCodes.RequestFailed, 'rename is ambiguous');
    const handler = createDocumentRequestHandler(
      { snapshot: () => document },
      { servingWorkspaceFor: () => workspace },
      suspender,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => 'neutral',
        resolve: async () => { throw failure; },
      },
    );

    await expect(handler({ uri: document.uri })).rejects.toBe(failure);

    suspender.suspend();
    const suspended = handler({ uri: document.uri });
    suspender.release();

    await expect(suspended).rejects.toBe(failure);
  });
});
