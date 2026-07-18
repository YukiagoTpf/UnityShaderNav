import { describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  Diagnostic,
  PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { registerDiagnosticsPublisher } from '../../src/handlers/diagnostics';
import { registerDocuments } from '../../src/handlers/documents';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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

type OpenHandler = (event: {
  textDocument: { uri: string; languageId: string; version: number; text: string };
}) => void;
type CloseHandler = (event: { textDocument: { uri: string } }) => void;

function documentConnection(
  sendDiagnostics: (params: PublishDiagnosticsParams) => Promise<void>,
): {
  readonly connection: Connection;
  readonly open: OpenHandler;
  readonly close: CloseHandler;
  readonly errors: string[];
} {
  let open: OpenHandler | undefined;
  let close: CloseHandler | undefined;
  const errors: string[] = [];
  const disposable = { dispose() {} };
  const connection = {
    console: { log() {}, error(message: string) { errors.push(message); } },
    onDidOpenTextDocument(handler: OpenHandler) {
      open = handler;
      return disposable;
    },
    onDidChangeTextDocument() { return disposable; },
    onDidCloseTextDocument(handler: CloseHandler) {
      close = handler;
      return disposable;
    },
    onWillSaveTextDocument() { return disposable; },
    onWillSaveTextDocumentWaitUntil() { return disposable; },
    onDidSaveTextDocument() { return disposable; },
    sendDiagnostics,
  } as unknown as Connection;
  return {
    connection,
    open: (event) => open?.(event),
    close: (event) => close?.(event),
    errors,
  };
}

function publisherScenario(
  sendDiagnostics: (params: PublishDiagnosticsParams) => Promise<void>,
  diagnosticsAt: (document: IndexedDocumentSnapshot) => Promise<Diagnostic[] | null>,
) {
  const harness = documentConnection(sendDiagnostics);
  const workspace = {
    updateDocument: vi.fn(async () => true),
    closeDocument: vi.fn(async () => {}),
    diagnosticsAt: vi.fn(diagnosticsAt),
  } as unknown as IndexedWorkspace;
  let refresh: (() => void) | undefined;
  const manager = {
    workspaceFor: () => workspace,
    servingWorkspaceFor: () => workspace,
    workspaceForOrCreateFile: vi.fn(async () => workspace),
    releaseDocument: vi.fn(async () => {}),
    configureOpenDocumentsProvider: vi.fn(),
    configureDiagnosticsRefresh(candidate: () => void) { refresh = candidate; },
  };
  const documents = registerDocuments(harness.connection, manager as never);
  registerDiagnosticsPublisher(harness.connection, documents, manager as never);
  return {
    ...harness,
    documents,
    refresh: () => refresh?.(),
  };
}

describe('registerDiagnosticsPublisher', () => {
  it('orders close clearing after an in-flight publish for the representative URI', async () => {
    const representativeUri = 'file:///C:/Project/Assets/Live.shader';
    const equivalentCloseUri = 'file:///c:/project/assets/live.shader';
    const firstSend = deferred<void>();
    const sends: PublishDiagnosticsParams[] = [];
    const scenario = publisherScenario(
      async (params) => {
        sends.push(params);
        if (sends.length === 1) await firstSend.promise;
      },
      async () => [diagnostic('old')],
    );

    scenario.open({
      textDocument: {
        uri: representativeUri,
        languageId: 'shaderlab',
        version: 1,
        text: 'Shader "Live" {}',
      },
    });
    scenario.refresh();
    await flush();
    expect(sends).toEqual([{
      uri: representativeUri,
      version: 1,
      diagnostics: [diagnostic('old')],
    }]);

    scenario.close({ textDocument: { uri: equivalentCloseUri } });
    await flush();
    expect(sends).toHaveLength(1);

    firstSend.resolve();
    await flush();
    expect(sends).toEqual([
      {
        uri: representativeUri,
        version: 1,
        diagnostics: [diagnostic('old')],
      },
      { uri: representativeUri, diagnostics: [] },
    ]);
  });

  it('does not clear or overwrite a same-version reopened session', async () => {
    const reopenedUri = 'file:///project/Assets/Reopened.shader';
    const firstSend = deferred<void>();
    const sends: PublishDiagnosticsParams[] = [];
    const scenario = publisherScenario(
      async (params) => {
        sends.push(params);
        if (sends.length === 1) await firstSend.promise;
      },
      async (current) => [diagnostic(current.openId === 1 ? 'old' : 'fresh')],
    );
    const open = (text: string): void => scenario.open({
      textDocument: {
        uri: reopenedUri,
        languageId: 'shaderlab',
        version: 1,
        text,
      },
    });

    open('Shader "Old" {}');
    scenario.refresh();
    await flush();
    expect(sends).toEqual([{
      uri: reopenedUri,
      version: 1,
      diagnostics: [diagnostic('old')],
    }]);

    scenario.close({ textDocument: { uri: reopenedUri } });
    open('Shader "Fresh" {}');
    scenario.refresh();
    await flush();
    expect(sends).toHaveLength(1);
    expect(scenario.documents.snapshot(reopenedUri)).toMatchObject({
      openId: 2,
      version: 1,
      text: 'Shader "Fresh" {}',
    });

    firstSend.resolve();
    await flush(24);
    expect(sends).toEqual([
      {
        uri: reopenedUri,
        version: 1,
        diagnostics: [diagnostic('old')],
      },
      {
        uri: reopenedUri,
        version: 1,
        diagnostics: [diagnostic('fresh')],
      },
    ]);
  });

  it('continues with close clearing after an in-flight publish fails', async () => {
    const failingUri = 'file:///project/Assets/Failing.shader';
    const firstSend = deferred<void>();
    const sends: PublishDiagnosticsParams[] = [];
    const scenario = publisherScenario(
      async (params) => {
        sends.push(params);
        if (sends.length === 1) await firstSend.promise;
      },
      async () => [diagnostic('before failure')],
    );

    scenario.open({
      textDocument: {
        uri: failingUri,
        languageId: 'shaderlab',
        version: 7,
        text: 'Shader "Failing" {}',
      },
    });
    scenario.refresh();
    await flush();
    expect(sends).toHaveLength(1);

    scenario.close({ textDocument: { uri: failingUri } });
    await flush();
    expect(sends).toHaveLength(1);

    firstSend.reject(new Error('transport failed'));
    await flush(24);
    expect(sends).toEqual([
      {
        uri: failingUri,
        version: 7,
        diagnostics: [diagnostic('before failure')],
      },
      { uri: failingUri, diagnostics: [] },
    ]);
    expect(scenario.errors).toEqual([
      '[UnityShaderNav] diagnostics publication failed: transport failed',
    ]);
  });

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
      onDidCloseSnapshot: vi.fn(),
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
        onDidCloseSnapshot: vi.fn(),
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
        onDidCloseSnapshot: vi.fn(),
      },
      manager as never,
    );

    refresh?.();
    await flush();

    expect(sendDiagnostics).not.toHaveBeenCalled();
  });
});
