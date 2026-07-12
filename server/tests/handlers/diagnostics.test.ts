import { describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  Diagnostic,
  PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { registerDiagnosticsPublisher } from '../../src/handlers/diagnostics';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

function document(version: number, text: string): IndexedDocumentSnapshot {
  return {
    uri: 'file:///project/Assets/Live.shader',
    languageId: 'shaderlab',
    openId: 4,
    version,
    text,
  };
}

function diagnostic(message: string): Diagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 4 },
    },
    message,
  };
}

describe('registerDiagnosticsPublisher', () => {
  it('discards an older document attempt and publishes only the latest version', async () => {
    let current = document(1, '#pragma vertex Old');
    const first = deferred<Diagnostic[] | null>();
    const second = deferred<Diagnostic[] | null>();
    const diagnosticsAt = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const workspace = { diagnosticsAt } as IndexedWorkspace;
    const sendDiagnostics = vi.fn(async (_params: PublishDiagnosticsParams) => {});
    let refresh: (() => void) | undefined;
    const manager = {
      servingWorkspaceFor: () => workspace,
      configureDiagnosticsRefresh(candidate: () => void) { refresh = candidate; },
    };
    const documents = {
      snapshot: () => current,
      openSnapshots: () => [current],
    };
    const connection = {
      sendDiagnostics,
      console: { error: vi.fn() },
    } as unknown as Connection;
    registerDiagnosticsPublisher(connection, documents, manager as never);

    refresh?.();
    await flush();
    expect(diagnosticsAt).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));

    current = document(2, '#pragma vertex New');
    refresh?.();
    first.resolve([diagnostic('old')]);
    await flush();
    expect(diagnosticsAt).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }));

    second.resolve([diagnostic('new')]);
    await flush();
    expect(sendDiagnostics).toHaveBeenCalledTimes(1);
    expect(sendDiagnostics).toHaveBeenCalledWith({
      uri: current.uri,
      version: 2,
      diagnostics: [diagnostic('new')],
    });
  });

  it('clears diagnostics when no serving workspace owns an open document', async () => {
    const current = document(3, '#pragma vertex Missing');
    const sendDiagnostics = vi.fn(async (_params: PublishDiagnosticsParams) => {});
    let refresh: (() => void) | undefined;
    const manager = {
      servingWorkspaceFor: () => undefined,
      configureDiagnosticsRefresh(candidate: () => void) { refresh = candidate; },
    };
    registerDiagnosticsPublisher(
      {
        sendDiagnostics,
        console: { error: vi.fn() },
      } as unknown as Connection,
      {
        snapshot: () => current,
        openSnapshots: () => [current],
      },
      manager as never,
    );

    refresh?.();
    await flush();

    expect(sendDiagnostics).toHaveBeenCalledWith({
      uri: current.uri,
      version: 3,
      diagnostics: [],
    });
  });

  it('drops a result when workspace revision validation rejects it', async () => {
    const current = document(5, '#pragma kernel Changed');
    const workspace = {
      diagnosticsAt: vi.fn(async () => null),
    } as unknown as IndexedWorkspace;
    const sendDiagnostics = vi.fn(async (_params: PublishDiagnosticsParams) => {});
    let refresh: (() => void) | undefined;
    const manager = {
      servingWorkspaceFor: () => workspace,
      configureDiagnosticsRefresh(candidate: () => void) { refresh = candidate; },
    };
    registerDiagnosticsPublisher(
      {
        sendDiagnostics,
        console: { error: vi.fn() },
      } as unknown as Connection,
      {
        snapshot: () => current,
        openSnapshots: () => [current],
      },
      manager as never,
    );

    refresh?.();
    await flush();

    expect(sendDiagnostics).not.toHaveBeenCalled();
  });
});
