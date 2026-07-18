import { describe, expect, it, vi } from 'vitest';
import {
  TextDocumentSyncKind,
  type Connection,
} from 'vscode-languageserver/node';
import { registerDocuments } from '../../src/handlers/documents';
import { uriKey } from '../../src/uriKey';
import type { IndexedWorkspace } from '../../src/workspace/indexedWorkspace';

type OpenHandler = (event: {
  textDocument: { uri: string; languageId: string; version: number; text: string };
}) => void;
type ChangeHandler = (event: {
  textDocument: { uri: string; version: number };
  contentChanges: { text: string }[];
}) => void;
type CloseHandler = (event: { textDocument: { uri: string } }) => void;

function createConnectionHarness(): {
  connection: Connection;
  open: OpenHandler;
  change: ChangeHandler;
  close: CloseHandler;
  errors: string[];
  diagnostics: unknown[];
} {
  let open: OpenHandler | undefined;
  let change: ChangeHandler | undefined;
  let close: CloseHandler | undefined;
  const errors: string[] = [];
  const diagnostics: unknown[] = [];
  const disposable = { dispose() {} };
  const connection = {
    console: {
      log() {},
      error(message: string) { errors.push(message); },
    },
    onDidOpenTextDocument(handler: OpenHandler) {
      open = handler;
      return disposable;
    },
    onDidChangeTextDocument(handler: ChangeHandler) {
      change = handler;
      return disposable;
    },
    onDidCloseTextDocument(handler: CloseHandler) {
      close = handler;
      return disposable;
    },
    onWillSaveTextDocument() { return disposable; },
    onWillSaveTextDocumentWaitUntil() { return disposable; },
    onDidSaveTextDocument() { return disposable; },
    sendDiagnostics(params: unknown) {
      diagnostics.push(params);
      return Promise.resolve();
    },
  } as unknown as Connection;
  return {
    connection,
    open: (event) => open?.(event),
    change: (event) => change?.(event),
    close: (event) => close?.(event),
    errors,
    diagnostics,
  };
}

function workspaceFixture(): IndexedWorkspace {
  return {
    updateDocument: vi.fn(async () => true),
    closeDocument: vi.fn(async () => {}),
    definitionAt: vi.fn(async () => null),
    referencesAt: vi.fn(async () => null),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromises(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) await Promise.resolve();
}

const uri = 'file:///t/doc.hlsl';
const openEvent = (text: string, version = 1) => ({
  textDocument: { uri, languageId: 'hlsl', version, text },
});
const changeEvent = (text: string, version: number) => ({
  textDocument: { uri, version },
  contentChanges: [{ text }],
});

describe('registerDocuments', () => {
  it('uses one canonical identity for equivalent Windows file URIs', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const manager = {
      workspaceFor: () => workspace,
      servingWorkspaceFor: () => workspace,
      workspaceForOrCreateFile: vi.fn(async () => workspace),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    const upperUri = 'file:///C:/Project/Canonical.hlsl';
    const lowerUri = 'file:///c:/Project/Canonical.hlsl';
    const canonicalUri = uriKey(upperUri);
    const registered = registerDocuments(harness.connection, manager);

    harness.open({
      textDocument: {
        uri: upperUri,
        languageId: 'hlsl',
        version: 1,
        text: 'float4 Opened() { return 0; }',
      },
    });
    await flushPromises();

    expect((harness.connection as unknown as { __textDocumentSync: number })
      .__textDocumentSync).toBe(TextDocumentSyncKind.Incremental);
    expect(registered.documents.get(upperUri)?.uri).toBe(canonicalUri);
    expect(registered.snapshot(upperUri)).toEqual(registered.snapshot(lowerUri));
    expect(registered.snapshot(lowerUri)).toMatchObject({
      uri: canonicalUri,
      openId: 1,
      version: 1,
    });

    harness.change({
      textDocument: { uri: lowerUri, version: 2 },
      contentChanges: [{ text: 'float4 Changed() { return 0; }' }],
    });
    await flushPromises();
    expect(registered.snapshot(upperUri)).toMatchObject({
      uri: canonicalUri,
      openId: 1,
      version: 2,
      text: 'float4 Changed() { return 0; }',
    });

    harness.close({ textDocument: { uri: lowerUri } });
    await flushPromises();
    expect(workspace.closeDocument).toHaveBeenCalledWith({ uri: canonicalUri, openId: 1 });
    expect(manager.releaseDocument).toHaveBeenCalledWith(canonicalUri);
    expect(registered.snapshot(upperUri)).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')('routes macOS case and Unicode variants to one open document', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const manager = {
      workspaceFor: () => workspace,
      servingWorkspaceFor: () => workspace,
      workspaceForOrCreateFile: vi.fn(async () => workspace),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    const nfcUri = 'file:///Users/Caf%C3%A9/Project/Main.hlsl';
    const nfdCaseVariant = 'file:///users/CAFE%CC%81/project/main.hlsl';
    const canonicalUri = uriKey(nfcUri);
    const registered = registerDocuments(harness.connection, manager);

    harness.open({
      textDocument: {
        uri: nfcUri,
        languageId: 'hlsl',
        version: 1,
        text: 'float4 Opened() { return 0; }',
      },
    });
    await flushPromises();

    expect(registered.snapshot(nfdCaseVariant)).toMatchObject({ uri: canonicalUri, openId: 1 });

    harness.close({ textDocument: { uri: nfdCaseVariant } });
    await flushPromises();
    expect(workspace.closeDocument).toHaveBeenCalledWith({ uri: canonicalUri, openId: 1 });
    expect(registered.snapshot(nfcUri)).toBeUndefined();
  });

  it('deduplicates didOpen content and routes close through behavior methods', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const manager = {
      workspaceFor: () => workspace,
      servingWorkspaceFor: () => workspace,
      workspaceForOrCreateFile: vi.fn(async () => workspace),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };

    const registered = registerDocuments(harness.connection, manager);
    harness.open(openEvent('float4 Opened() { return 0; }'));
    await flushPromises();

    expect(workspace.updateDocument).toHaveBeenCalledTimes(1);
    expect(registered.snapshot(uri)).toMatchObject({ openId: 1, version: 1 });

    harness.close({ textDocument: { uri } });
    await flushPromises();
    expect(workspace.closeDocument).toHaveBeenCalledWith({ uri, openId: 1 });
    expect(registered.snapshot(uri)).toBeUndefined();
    expect(harness.diagnostics).toContainEqual({
      uri,
      diagnostics: [],
    });
  });

  it('keeps one lazy ensure and submits only the latest edit', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const pending = deferred<IndexedWorkspace | undefined>();
    const manager = {
      workspaceFor: () => undefined,
      servingWorkspaceFor: () => undefined,
      workspaceForOrCreateFile: vi.fn(() => pending.promise),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    const registered = registerDocuments(harness.connection, manager);

    harness.open(openEvent('float4 V1() { return 0; }'));
    harness.change(changeEvent('float4 V2() { return 0; }', 2));
    harness.change(changeEvent('float4 V3() { return 0; }', 3));
    expect(manager.workspaceForOrCreateFile).toHaveBeenCalledTimes(1);
    expect(registered.snapshot(uri)).toMatchObject({
      text: 'float4 V3() { return 0; }',
      version: 3,
    });

    pending.resolve(workspace);
    await flushPromises();
    expect(workspace.updateDocument).toHaveBeenCalledTimes(1);
    expect(workspace.updateDocument).toHaveBeenCalledWith(expect.objectContaining({
      text: 'float4 V3() { return 0; }',
      version: 3,
    }));
  });

  it('does not resurrect a document closed while lazy routing is pending', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const pending = deferred<IndexedWorkspace | undefined>();
    const manager = {
      workspaceFor: () => undefined,
      servingWorkspaceFor: () => undefined,
      workspaceForOrCreateFile: vi.fn(() => pending.promise),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    registerDocuments(harness.connection, manager);

    harness.open(openEvent('float4 Closed() { return 0; }'));
    harness.close({ textDocument: { uri } });
    pending.resolve(workspace);
    await flushPromises();

    expect(workspace.updateDocument).not.toHaveBeenCalled();
    expect(workspace.closeDocument).not.toHaveBeenCalled();
    expect(manager.workspaceForOrCreateFile).toHaveBeenCalledTimes(1);
  });

  it('uses a new openId when the same URI reopens at the same version', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const pending = deferred<IndexedWorkspace | undefined>();
    const manager = {
      workspaceFor: () => undefined,
      servingWorkspaceFor: () => undefined,
      workspaceForOrCreateFile: vi.fn(() => pending.promise),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    registerDocuments(harness.connection, manager);

    harness.open(openEvent('float4 Stale() { return 0; }'));
    harness.close({ textDocument: { uri } });
    harness.open(openEvent('float4 Fresh() { return 0; }'));
    pending.resolve(workspace);
    await flushPromises();

    expect(workspace.updateDocument).toHaveBeenCalledTimes(1);
    expect(workspace.updateDocument).toHaveBeenCalledWith(expect.objectContaining({
      openId: 2,
      version: 1,
      text: 'float4 Fresh() { return 0; }',
    }));
  });

  it('reroutes a reopened session when the retired lazy route returns no workspace', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const retiredRoute = deferred<IndexedWorkspace | undefined>();
    const manager = {
      workspaceFor: () => undefined,
      servingWorkspaceFor: () => undefined,
      workspaceForOrCreateFile: vi.fn()
        .mockImplementationOnce(() => retiredRoute.promise)
        .mockResolvedValueOnce(workspace),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    registerDocuments(harness.connection, manager);

    harness.open(openEvent('float4 FirstSession() { return 0; }'));
    harness.close({ textDocument: { uri } });
    harness.open(openEvent('float4 ReopenedSession() { return 0; }'));
    retiredRoute.resolve(undefined);
    await flushPromises();

    expect(manager.workspaceForOrCreateFile).toHaveBeenCalledTimes(2);
    expect(workspace.updateDocument).toHaveBeenCalledWith(expect.objectContaining({
      openId: 2,
      version: 1,
      text: 'float4 ReopenedSession() { return 0; }',
    }));
  });

  it('logs a lazy routing rejection and retries on the next edit', async () => {
    const harness = createConnectionHarness();
    const workspace = workspaceFixture();
    const first = deferred<IndexedWorkspace | undefined>();
    const manager = {
      workspaceFor: () => undefined,
      servingWorkspaceFor: () => undefined,
      workspaceForOrCreateFile: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce(workspace),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    registerDocuments(harness.connection, manager);

    harness.open(openEvent('float4 First() { return 0; }'));
    first.reject(new Error('bootstrap failed'));
    await flushPromises();
    expect(harness.errors).toEqual([
      '[UnityShaderNav] document routing failed for file:///t/doc.hlsl: bootstrap failed',
    ]);

    harness.change(changeEvent('float4 Retried() { return 0; }', 2));
    await flushPromises();
    expect(manager.workspaceForOrCreateFile).toHaveBeenCalledTimes(2);
    expect(workspace.updateDocument).toHaveBeenCalledWith(expect.objectContaining({
      version: 2,
      text: 'float4 Retried() { return 0; }',
    }));
  });
});
