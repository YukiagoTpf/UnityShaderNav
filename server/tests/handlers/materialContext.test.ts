import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import {
  MATERIAL_CONTEXT_REQUEST,
  type MaterialContextParams,
  type MaterialContextResult,
} from '@unity-shader-nav/shared';
import { registerMaterialContextHandler } from '../../src/handlers/materialContext';
import type { WorkspaceManager } from '../../src/workspace';

type Handler = (params: MaterialContextParams) => Promise<MaterialContextResult>;

function captureHandler(): { connection: Connection; handler(): Handler } {
  let registered: Handler | undefined;
  return {
    connection: {
      onRequest(method: string, handler: Handler) {
        expect(method).toBe(MATERIAL_CONTEXT_REQUEST);
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

describe('registerMaterialContextHandler', () => {
  it('delegates the active source URI to the owning Workspace', async () => {
    const { connection, handler } = captureHandler();
    const uri = 'file:///Project/Assets/Shaders/Lit.shader';
    const result: MaterialContextResult = {
      status: 'unavailable',
      reason: 'no-selection',
    };
    const materialContextFor = vi.fn(async () => result);
    registerMaterialContextHandler(
      connection,
      { materialContextFor } as unknown as WorkspaceManager,
    );

    await expect(handler()({ textDocument: { uri } })).resolves.toEqual(result);
    expect(materialContextFor).toHaveBeenCalledWith(uri);
  });
});
