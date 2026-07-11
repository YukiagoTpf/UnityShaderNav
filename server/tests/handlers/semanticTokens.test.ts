import { describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  SemanticTokens,
  SemanticTokensParams,
} from 'vscode-languageserver/node';
import {
  registerSemanticTokensHandler,
  SEMANTIC_TOKEN_TYPES,
} from '../../src/handlers/semanticTokens';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  IndexedWorkspaceRequestRouter,
} from '../../src/workspace/indexedWorkspace';
import { SEMANTIC_TOKEN_TYPES as QUERY_TOKEN_TYPES } from '../../src/workspace/queries';

type Handler = (params: SemanticTokensParams) => Promise<SemanticTokens>;

function captureHandler(): { connection: Connection; handler: () => Handler } {
  let registered: Handler | undefined;
  const connection = {
    languages: {
      semanticTokens: {
        on(handler: Handler) {
          registered = handler;
          return { dispose() {} };
        },
      },
    },
  } as unknown as Connection;
  return {
    connection,
    handler: () => {
      if (!registered) throw new Error('semantic tokens handler was not registered');
      return registered;
    },
  };
}

function registry(document?: IndexedDocumentSnapshot): Pick<IndexedDocumentRegistry, 'snapshot'> {
  return {
    snapshot: (uri) => document?.uri === uri ? document : undefined,
  };
}

function fakeWorkspace(semanticTokens: IndexedWorkspace['semanticTokens']): IndexedWorkspace {
  return { semanticTokens } as IndexedWorkspace;
}

const uri = 'file:///project/Assets/Live.shader';
const document: IndexedDocumentSnapshot = {
  uri,
  languageId: 'shaderlab',
  text: 'Shader "Live" {}',
  openId: 4,
  version: 2,
};

describe('registerSemanticTokensHandler', () => {
  it('re-exports the revision-owned semantic token legend', () => {
    expect(SEMANTIC_TOKEN_TYPES).toBe(QUERY_TOKEN_TYPES);
  });

  it('routes an open snapshot and delegates the immutable query input', async () => {
    const { connection, handler } = captureHandler();
    const tokens = { data: [0, 0, 6, 6, 0] };
    const semanticTokens = vi.fn(async () => tokens);
    const workspace = fakeWorkspace(semanticTokens);
    const documents = registry(document);
    const manager: IndexedWorkspaceRequestRouter = {
      servingWorkspaceFor: () => workspace,
    };
    registerSemanticTokensHandler(connection, documents, manager);

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual(tokens);
    expect(semanticTokens).toHaveBeenCalledOnce();
    expect(semanticTokens).toHaveBeenCalledWith({ uri, document });
  });

  it('lazily restores a missing route for a current open session', async () => {
    const { connection, handler } = captureHandler();
    const semanticTokens = vi.fn(async () => ({ data: [] }));
    const workspace = fakeWorkspace(semanticTokens);
    const documents = registry(document);
    const workspaceForOrCreateFile = vi.fn(async (
      _uri: string,
      shouldCreate?: () => boolean,
    ) => shouldCreate?.() ? workspace : undefined);
    registerSemanticTokensHandler(connection, documents, {
      servingWorkspaceFor: () => undefined,
      workspaceFor: () => undefined,
      workspaceForOrCreateFile,
    });

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual({ data: [] });
    expect(workspaceForOrCreateFile).toHaveBeenCalledWith(uri, expect.any(Function));
    expect(semanticTokens).toHaveBeenCalledWith({ uri, document });
  });

  it('queries a serving disk revision when the document is closed', async () => {
    const { connection, handler } = captureHandler();
    const tokens = { data: [0, 1, 2, 0, 0] };
    const semanticTokens = vi.fn(async () => tokens);
    const workspace = fakeWorkspace(semanticTokens);
    registerSemanticTokensHandler(connection, registry(), {
      servingWorkspaceFor: (requestedUri) => requestedUri === uri ? workspace : undefined,
    });

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual(tokens);
    expect(semanticTokens).toHaveBeenCalledWith({ uri, document: undefined });
  });

  it('returns an empty stream when no serving revision owns the request', async () => {
    const { connection, handler } = captureHandler();
    registerSemanticTokensHandler(connection, registry(), {
      servingWorkspaceFor: () => undefined,
    });

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual({ data: [] });
  });
});
