import { describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  DocumentSymbol,
  DocumentSymbolParams,
} from 'vscode-languageserver/node';
import { registerDocumentSymbolHandler } from '../../src/handlers/documentSymbol';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  IndexedWorkspaceRequestRouter,
} from '../../src/workspace/indexedWorkspace';

type Handler = (params: DocumentSymbolParams) => Promise<DocumentSymbol[] | null>;

function captureHandler(): { connection: Connection; handler: () => Handler } {
  let registered: Handler | undefined;
  const connection = {
    onDocumentSymbol(handler: Handler) {
      registered = handler;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    handler: () => {
      if (!registered) throw new Error('document symbol handler was not registered');
      return registered;
    },
  };
}

function registry(document?: IndexedDocumentSnapshot): Pick<IndexedDocumentRegistry, 'snapshot'> {
  return {
    snapshot: (uri) => document?.uri === uri ? document : undefined,
  };
}

function fakeWorkspace(
  documentSymbols: IndexedWorkspace['documentSymbols'],
): IndexedWorkspace {
  return { documentSymbols } as IndexedWorkspace;
}

const uri = 'file:///project/Assets/Live.hlsl';
const document: IndexedDocumentSnapshot = {
  uri,
  languageId: 'hlsl',
  text: 'float4 LiveOutline() { return 0; }',
  openId: 7,
  version: 3,
};

describe('registerDocumentSymbolHandler', () => {
  it('routes an open snapshot and delegates the immutable query input', async () => {
    const { connection, handler } = captureHandler();
    const symbols = [{
      name: 'LiveOutline',
      detail: 'function',
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 41 } },
      selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 18 } },
    }];
    const documentSymbols = vi.fn(async () => symbols);
    const workspace = fakeWorkspace(documentSymbols);
    const documents = registry(document);
    const manager: IndexedWorkspaceRequestRouter = {
      servingWorkspaceFor: () => workspace,
    };
    registerDocumentSymbolHandler(connection, documents, manager);

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual(symbols);
    expect(documentSymbols).toHaveBeenCalledOnce();
    expect(documentSymbols).toHaveBeenCalledWith({ uri, document });
  });

  it('lazily restores a missing route only while the open session is current', async () => {
    const { connection, handler } = captureHandler();
    const documentSymbols = vi.fn(async () => []);
    const workspace = fakeWorkspace(documentSymbols);
    const documents = registry(document);
    const workspaceForOrCreateFile = vi.fn(async (
      _uri: string,
      shouldCreate?: () => boolean,
    ) => shouldCreate?.() ? workspace : undefined);
    const manager: IndexedWorkspaceRequestRouter = {
      servingWorkspaceFor: () => undefined,
      workspaceFor: () => undefined,
      workspaceForOrCreateFile,
    };
    registerDocumentSymbolHandler(connection, documents, manager);

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual([]);
    expect(workspaceForOrCreateFile).toHaveBeenCalledWith(uri, expect.any(Function));
    expect(documentSymbols).toHaveBeenCalledWith({ uri, document });
  });

  it('queries a serving disk revision when the document is closed', async () => {
    const { connection, handler } = captureHandler();
    const documentSymbols = vi.fn(async () => []);
    const workspace = fakeWorkspace(documentSymbols);
    const manager: IndexedWorkspaceRequestRouter = {
      servingWorkspaceFor: (requestedUri) => requestedUri === uri ? workspace : undefined,
    };
    registerDocumentSymbolHandler(connection, registry(), manager);

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual([]);
    expect(documentSymbols).toHaveBeenCalledWith({ uri, document: undefined });
  });

  it('returns null when no serving revision owns the request', async () => {
    const { connection, handler } = captureHandler();
    registerDocumentSymbolHandler(connection, registry(), {
      servingWorkspaceFor: () => undefined,
    });

    await expect(handler()({ textDocument: { uri } })).resolves.toBeNull();
  });

  it('waits for the request suspender before delegating', async () => {
    const { connection, handler } = captureHandler();
    const documentSymbols = vi.fn(async () => []);
    const workspace = fakeWorkspace(documentSymbols);
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();
    registerDocumentSymbolHandler(connection, registry(document), {
      servingWorkspaceFor: () => workspace,
    }, suspender);

    const result = handler()({ textDocument: { uri } });
    await Promise.resolve();
    expect(documentSymbols).not.toHaveBeenCalled();

    suspender.release();
    await expect(result).resolves.toEqual([]);
    expect(documentSymbols).toHaveBeenCalledOnce();
  });
});
