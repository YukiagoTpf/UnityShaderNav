import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import {
  INCLUDE_POINT_CONTEXTS_REQUEST,
  type IncludePointContextsParams,
  type IncludePointContextsResult,
} from '@unity-shader-nav/shared';
import { registerIncludePointContextsHandler } from '../../src/handlers/includePointContexts';
import type { WorkspaceManager } from '../../src/workspace';

type Handler = (params: IncludePointContextsParams) => Promise<IncludePointContextsResult>;

function captureHandler(): { connection: Connection; handler(): Handler } {
  let registered: Handler | undefined;
  return {
    connection: {
      onRequest(method: string, handler: Handler) {
        expect(method).toBe(INCLUDE_POINT_CONTEXTS_REQUEST);
        registered = handler;
        return { dispose() {} };
      },
    } as unknown as Connection,
    handler() {
      if (!registered) throw new Error('handler was not registered');
      return registered;
    },
  };
}

describe('registerIncludePointContextsHandler', () => {
  it('delegates the current shared-file URI to the revision-owning manager', async () => {
    const { connection, handler } = captureHandler();
    const uri = 'file:///Project/Shared.hlsl';
    const result: IncludePointContextsResult = {
      folderUri: 'file:///Project',
      revision: 3,
      publicationId: 'p3',
      contexts: [],
    };
    const knownIncludePointContextsFor = vi.fn(async () => result);
    registerIncludePointContextsHandler(
      connection,
      { knownIncludePointContextsFor } as unknown as WorkspaceManager,
    );

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual(result);
    expect(knownIncludePointContextsFor).toHaveBeenCalledWith(uri);
  });

  it('returns a neutral list when the request suspension times out', async () => {
    const { connection, handler } = captureHandler();
    registerIncludePointContextsHandler(
      connection,
      {} as WorkspaceManager,
      { run: async () => null } as never,
    );

    await expect(handler()({ textDocument: { uri: 'file:///Shared.hlsl' } }))
      .resolves.toEqual({ contexts: [] });
  });
});
