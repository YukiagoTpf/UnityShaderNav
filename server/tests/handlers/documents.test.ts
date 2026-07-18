import { describe, expect, it, vi } from 'vitest';
import {
  TextDocumentSyncKind,
  type Connection,
} from 'vscode-languageserver/node';
import { registerDocuments } from '../../src/handlers/documents';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';

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
} {
  let open: OpenHandler | undefined;
  let change: ChangeHandler | undefined;
  let close: CloseHandler | undefined;
  const errors: string[] = [];
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
  } as unknown as Connection;
  return {
    connection,
    open: (event) => open?.(event),
    change: (event) => change?.(event),
    close: (event) => close?.(event),
    errors,
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
    expect(registered.documents.get(upperUri)?.uri).toBe(upperUri);
    expect(registered.documents.get(lowerUri)?.uri).toBe(upperUri);
    expect(registered.snapshot(upperUri)).toEqual(registered.snapshot(lowerUri));
    expect(registered.snapshot(lowerUri)).toMatchObject({
      uri: upperUri,
      openId: 1,
      version: 1,
    });

    harness.change({
      textDocument: { uri: lowerUri, version: 2 },
      contentChanges: [{ text: 'float4 Changed() { return 0; }' }],
    });
    await flushPromises();
    expect(registered.snapshot(upperUri)).toMatchObject({
      uri: upperUri,
      openId: 1,
      version: 2,
      text: 'float4 Changed() { return 0; }',
    });

    harness.close({ textDocument: { uri: lowerUri } });
    await flushPromises();
    expect(workspace.closeDocument).toHaveBeenCalledWith({ uri: upperUri, openId: 1 });
    expect(manager.releaseDocument).toHaveBeenCalledWith(upperUri);
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
    const nfcUri = 'file:///project/Caf%C3%A9/Main.hlsl';
    const nfdCaseVariant = 'file:///PROJECT/CAFE%CC%81/main.hlsl';
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

    expect(registered.documents.get(nfdCaseVariant)?.uri).toBe(nfcUri);
    expect(registered.snapshot(nfdCaseVariant)).toMatchObject({ uri: nfcUri, openId: 1 });

    harness.close({ textDocument: { uri: nfdCaseVariant } });
    await flushPromises();
    expect(workspace.closeDocument).toHaveBeenCalledWith({ uri: nfcUri, openId: 1 });
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
    const closedSnapshots: IndexedDocumentSnapshot[] = [];
    registered.onDidCloseSnapshot((document) => { closedSnapshots.push(document); });
    harness.open(openEvent('float4 Opened() { return 0; }'));
    await flushPromises();

    expect(workspace.updateDocument).toHaveBeenCalledTimes(1);
    expect(registered.snapshot(uri)).toMatchObject({ openId: 1, version: 1 });

    harness.close({ textDocument: { uri } });
    await flushPromises();
    expect(workspace.closeDocument).toHaveBeenCalledWith({ uri, openId: 1 });
    expect(registered.snapshot(uri)).toBeUndefined();
    expect(closedSnapshots).toContainEqual(expect.objectContaining({
      uri,
      openId: 1,
      version: 1,
    }));
  });

  it('coalesces rapid editor changes while exposing the latest snapshot immediately', async () => {
    vi.useFakeTimers();
    try {
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

      harness.open(openEvent('float4 V1() { return 0; }'));
      await flushPromises();
      expect(workspace.updateDocument).toHaveBeenCalledTimes(1);

      for (let version = 2; version <= 12; version++) {
        harness.change(changeEvent(`float4 V${version}() { return 0; }`, version));
      }
      expect(registered.snapshot(uri)).toMatchObject({
        version: 12,
        text: 'float4 V12() { return 0; }',
      });
      expect(workspace.updateDocument).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(74);
      expect(workspace.updateDocument).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await flushPromises();

      expect(workspace.updateDocument).toHaveBeenCalledTimes(2);
      expect(workspace.updateDocument).toHaveBeenLastCalledWith(expect.objectContaining({
        version: 12,
        text: 'float4 V12() { return 0; }',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recreate a removed owner from its delayed edit route', async () => {
    vi.useFakeTimers();
    try {
      const harness = createConnectionHarness();
      const workspace = workspaceFixture();
      let owner: IndexedWorkspace | undefined = workspace;
      const manager = {
        workspaceFor: () => owner,
        servingWorkspaceFor: () => owner,
        workspaceForOrCreateFile: vi.fn(async () => workspace),
        releaseDocument: vi.fn(async () => {}),
        configureOpenDocumentsProvider: vi.fn(),
      };
      const registered = registerDocuments(harness.connection, manager);

      harness.open(openEvent('float4 BeforeRemoval() { return 0; }'));
      await flushPromises();
      expect(workspace.updateDocument).toHaveBeenCalledTimes(1);

      harness.change(changeEvent('float4 DelayedEdit() { return 0; }', 2));
      expect(registered.snapshot(uri)).toMatchObject({ version: 2 });
      owner = undefined;
      await vi.advanceTimersByTimeAsync(75);
      await flushPromises();

      expect(manager.workspaceForOrCreateFile).not.toHaveBeenCalled();
      expect(workspace.updateDocument).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reroutes the latest edit when a lazy document update outlives the edit window', async () => {
    vi.useFakeTimers();
    const firstUpdate = deferred<boolean>();
    try {
      const harness = createConnectionHarness();
      const updateDocument = vi.fn()
        .mockImplementationOnce(() => firstUpdate.promise)
        .mockResolvedValue(true);
      const workspace = { ...workspaceFixture(), updateDocument };
      const manager = {
        workspaceFor: () => undefined,
        servingWorkspaceFor: () => undefined,
        workspaceForOrCreateFile: vi.fn(async () => workspace),
        releaseDocument: vi.fn(async () => {}),
        configureOpenDocumentsProvider: vi.fn(),
      };
      const registered = registerDocuments(harness.connection, manager);

      harness.open(openEvent('float4 V1() { return 0; }'));
      await flushPromises();
      expect(updateDocument).toHaveBeenCalledTimes(1);
      expect(updateDocument).toHaveBeenLastCalledWith(expect.objectContaining({ version: 1 }));

      harness.change(changeEvent('float4 V2() { return 0; }', 2));
      await vi.advanceTimersByTimeAsync(75);
      expect(registered.snapshot(uri)).toMatchObject({ version: 2 });
      expect(updateDocument).toHaveBeenCalledTimes(1);

      firstUpdate.resolve(true);
      await flushPromises();
      expect(updateDocument).toHaveBeenCalledTimes(2);
      expect(updateDocument).toHaveBeenLastCalledWith(expect.objectContaining({
        version: 2,
        text: 'float4 V2() { return 0; }',
      }));
    } finally {
      firstUpdate.resolve(true);
      vi.useRealTimers();
    }
  });

  it('does not let a delayed edit route cross a close and reopen boundary', async () => {
    vi.useFakeTimers();
    const releaseRetiredRoute = deferred<void>();
    try {
      const harness = createConnectionHarness();
      const workspace = workspaceFixture();
      let existingWorkspace: IndexedWorkspace | undefined = workspace;
      let retiredRouteCreatedWorkspace = false;
      const manager = {
        workspaceFor: () => existingWorkspace,
        servingWorkspaceFor: () => existingWorkspace,
        workspaceForOrCreateFile: vi.fn()
          .mockImplementationOnce(async (
            _uri: string,
            shouldCreate: () => boolean,
          ) => {
            await releaseRetiredRoute.promise;
            retiredRouteCreatedWorkspace = shouldCreate();
            return retiredRouteCreatedWorkspace ? workspace : undefined;
          })
          .mockResolvedValueOnce(workspace),
        releaseDocument: vi.fn(async () => {}),
        configureOpenDocumentsProvider: vi.fn(),
      };
      registerDocuments(harness.connection, manager);

      harness.open(openEvent('float4 FirstSession() { return 0; }'));
      await flushPromises();
      expect(workspace.updateDocument).toHaveBeenCalledWith(expect.objectContaining({
        openId: 1,
        version: 1,
      }));

      existingWorkspace = undefined;
      harness.change(changeEvent('float4 RetiredEdit() { return 0; }', 2));
      await vi.advanceTimersByTimeAsync(75);
      expect(manager.workspaceForOrCreateFile).toHaveBeenCalledTimes(1);

      harness.close({ textDocument: { uri } });
      harness.open(openEvent('float4 ReopenedSession() { return 0; }'));
      releaseRetiredRoute.resolve();
      await flushPromises();

      expect(retiredRouteCreatedWorkspace).toBe(false);
      expect(manager.workspaceForOrCreateFile).toHaveBeenCalledTimes(2);
      expect(workspace.updateDocument).toHaveBeenLastCalledWith(expect.objectContaining({
        openId: 2,
        version: 1,
        text: 'float4 ReopenedSession() { return 0; }',
      }));
    } finally {
      releaseRetiredRoute.resolve();
      vi.useRealTimers();
    }
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
    const pending = deferred<void>();
    let createdWorkspace = false;
    const manager = {
      workspaceFor: () => undefined,
      servingWorkspaceFor: () => undefined,
      workspaceForOrCreateFile: vi.fn(async (
        _uri: string,
        shouldCreate: () => boolean,
      ) => {
        await pending.promise;
        createdWorkspace = shouldCreate();
        return createdWorkspace ? workspace : undefined;
      }),
      releaseDocument: vi.fn(async () => {}),
      configureOpenDocumentsProvider: vi.fn(),
    };
    registerDocuments(harness.connection, manager);

    harness.open(openEvent('float4 Closed() { return 0; }'));
    harness.close({ textDocument: { uri } });
    pending.resolve();
    await flushPromises();

    expect(createdWorkspace).toBe(false);
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

    vi.useFakeTimers();
    try {
      harness.change(changeEvent('float4 Retried() { return 0; }', 2));
      await vi.advanceTimersByTimeAsync(75);
      await flushPromises();
      expect(manager.workspaceForOrCreateFile).toHaveBeenCalledTimes(2);
      expect(workspace.updateDocument).toHaveBeenCalledWith(expect.objectContaining({
        version: 2,
        text: 'float4 Retried() { return 0; }',
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
