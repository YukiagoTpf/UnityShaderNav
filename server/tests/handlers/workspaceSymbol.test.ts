import { describe, expect, it, vi } from 'vitest';
import {
  SymbolKind,
  type Connection,
  type SymbolInformation,
  type WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { registerWorkspaceSymbolHandler } from '../../src/handlers/workspaceSymbol';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import type { IndexedWorkspaceService } from '../../src/workspace/indexedWorkspace';

type Handler = (params: WorkspaceSymbolParams) => Promise<SymbolInformation[] | null>;

function captureHandler(): { connection: Connection; handler: () => Handler } {
  let registered: Handler | undefined;
  const connection = {
    onWorkspaceSymbol(handler: Handler) {
      registered = handler;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    handler: () => {
      if (!registered) throw new Error('workspace symbol handler was not registered');
      return registered;
    },
  };
}

const symbol: SymbolInformation = {
  name: 'MainTex',
  kind: SymbolKind.Variable,
  location: {
    uri: 'file:///project/Assets/Surface.hlsl',
    range: {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 8 },
    },
  },
};

describe('registerWorkspaceSymbolHandler', () => {
  it('delegates the original query to the cross-root service', async () => {
    const { connection, handler } = captureHandler();
    const workspaceSymbols = vi.fn(() => [symbol]);
    const manager: Pick<IndexedWorkspaceService, 'workspaceSymbols'> = { workspaceSymbols };
    registerWorkspaceSymbolHandler(connection, manager);

    await expect(handler()({ query: ' Main ' })).resolves.toEqual([symbol]);
    expect(workspaceSymbols).toHaveBeenCalledOnce();
    expect(workspaceSymbols).toHaveBeenCalledWith(' Main ');
  });

  it('does not inspect or reshape an empty service result', async () => {
    const { connection, handler } = captureHandler();
    const workspaceSymbols = vi.fn(() => []);
    registerWorkspaceSymbolHandler(connection, { workspaceSymbols });

    await expect(handler()({ query: '' })).resolves.toEqual([]);
    expect(workspaceSymbols).toHaveBeenCalledWith('');
  });

  it('waits for the request suspender before delegating', async () => {
    const { connection, handler } = captureHandler();
    const workspaceSymbols = vi.fn(() => [symbol]);
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();
    registerWorkspaceSymbolHandler(connection, { workspaceSymbols }, suspender);

    const result = handler()({ query: 'Main' });
    await Promise.resolve();
    expect(workspaceSymbols).not.toHaveBeenCalled();

    suspender.release();
    await expect(result).resolves.toEqual([symbol]);
    expect(workspaceSymbols).toHaveBeenCalledOnce();
  });

  it('returns the empty workspace-symbol neutral when suspension times out', async () => {
    const { connection, handler } = captureHandler();
    const workspaceSymbols = vi.fn(() => [symbol]);
    const suspender = {
      run: vi.fn(async () => null),
    } as unknown as Pick<RequestSuspender, 'run'>;
    registerWorkspaceSymbolHandler(connection, { workspaceSymbols }, suspender);

    await expect(handler()({ query: 'Main' })).resolves.toEqual([]);
    expect(workspaceSymbols).not.toHaveBeenCalled();
  });
});
