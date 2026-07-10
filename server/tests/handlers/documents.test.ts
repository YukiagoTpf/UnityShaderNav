import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import { registerDocuments } from '../../src/handlers/documents';

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
  logs: string[];
} {
  let open: OpenHandler | undefined;
  let change: ChangeHandler | undefined;
  let close: CloseHandler | undefined;
  const logs: string[] = [];
  const disposable = { dispose() {} };
  const connection = {
    console: { log(message: string) { logs.push(message); } },
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
    onWillSaveTextDocument() {
      return disposable;
    },
    onWillSaveTextDocumentWaitUntil() {
      return disposable;
    },
    onDidSaveTextDocument() {
      return disposable;
    },
  } as unknown as Connection;

  return {
    connection,
    open: (event) => open?.(event),
    change: (event) => change?.(event),
    close: (event) => close?.(event),
    logs,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate()).toBe(true);
}

describe('registerDocuments', () => {
  it('routes opened documents to their owning workspace and closes live overlays', async () => {
    const harness = createConnectionHarness();
    const calls: string[] = [];
    const workspace = {
      index: {
        async reindex(uri: string) {
          calls.push(`reindex:${uri}`);
        },
        closeDocument(uri: string) {
          calls.push(`close:${uri}`);
        },
      },
    };
    const manager = {
      workspaceFor(uri: string) {
        return uri === 'file:///t/doc.hlsl' ? workspace : undefined;
      },
      async workspaceForOrCreateFile(uri: string) {
        return this.workspaceFor(uri);
      },
    } as never;

    registerDocuments(harness.connection, manager);
    harness.open({
      textDocument: {
        uri: 'file:///t/doc.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 helper(float4 v) { return v; }',
      },
    });

    await waitFor(() => calls.includes('reindex:file:///t/doc.hlsl'));

    harness.close({ textDocument: { uri: 'file:///t/doc.hlsl' } });

    expect(calls).toContain('close:file:///t/doc.hlsl');
  });

  it('does not route documents outside known workspaces', async () => {
    const harness = createConnectionHarness();
    const calls: string[] = [];
    const manager = {
      workspaceFor() {
        return undefined;
      },
      async workspaceForOrCreateFile() {
        return undefined;
      },
    } as never;

    registerDocuments(harness.connection, manager);
    harness.open({
      textDocument: {
        uri: 'file:///outside/once.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 helper(float4 v) { return v; }',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toEqual([]);
  });

  it('does not restore an index after the document closes during indexing', async () => {
    const harness = createConnectionHarness();
    const calls: string[] = [];
    let allowReindex!: () => void;
    const reindexStarted = new Promise<void>((resolve) => {
      allowReindex = resolve;
    });
    const workspace = {
      index: {
        async reindex(uri: string, _text: string, shouldStore: () => boolean) {
          await reindexStarted;
          if (shouldStore()) calls.push(`reindex:${uri}`);
        },
        closeDocument(uri: string) {
          calls.push(`close:${uri}`);
        },
      },
    };
    const manager = {
      workspaceFor(uri: string) {
        return uri === 'file:///t/closed.hlsl' ? workspace : undefined;
      },
      async workspaceForOrCreateFile(uri: string) {
        return this.workspaceFor(uri);
      },
    } as never;

    registerDocuments(harness.connection, manager);
    harness.open({
      textDocument: {
        uri: 'file:///t/closed.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 helper(float4 v) { return v; }',
      },
    });
    harness.close({ textDocument: { uri: 'file:///t/closed.hlsl' } });
    allowReindex();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls).toEqual(['close:file:///t/closed.hlsl']);
  });

  it('does not store stale text after a newer document version arrives during indexing', async () => {
    const harness = createConnectionHarness();
    const calls: string[] = [];
    let allowStaleReindex!: () => void;
    const staleReindex = new Promise<void>((resolve) => {
      allowStaleReindex = resolve;
    });
    const workspace = {
      index: {
        async reindex(_uri: string, text: string, shouldStore: () => boolean) {
          if (text.includes('Stale')) await staleReindex;
          if (shouldStore()) calls.push(`store:${text}`);
        },
        closeDocument() {},
      },
    };
    const manager = {
      workspaceFor(uri: string) {
        return uri === 'file:///t/versioned.hlsl' ? workspace : undefined;
      },
      async workspaceForOrCreateFile(uri: string) {
        return this.workspaceFor(uri);
      },
    } as never;

    registerDocuments(harness.connection, manager);
    harness.open({
      textDocument: {
        uri: 'file:///t/versioned.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 Stale() { return 0; }',
      },
    });
    harness.change({
      textDocument: {
        uri: 'file:///t/versioned.hlsl',
        version: 2,
      },
      contentChanges: [{ text: 'float4 Fresh() { return 0; }' }],
    });
    allowStaleReindex();

    await waitFor(() => calls.includes('store:float4 Fresh() { return 0; }'));

    expect(calls).toEqual(['store:float4 Fresh() { return 0; }']);
  });

  it('does not store stale text after the same URI closes and reopens at the same version', async () => {
    const harness = createConnectionHarness();
    const calls: string[] = [];
    let allowStaleReindex!: () => void;
    const staleReindex = new Promise<void>((resolve) => {
      allowStaleReindex = resolve;
    });
    const workspace = {
      index: {
        async reindex(_uri: string, text: string, shouldStore: () => boolean) {
          if (text.includes('Stale')) await staleReindex;
          if (shouldStore()) calls.push(`store:${text}`);
        },
        closeDocument(uri: string) {
          calls.push(`close:${uri}`);
        },
      },
    };
    const manager = {
      workspaceFor(uri: string) {
        return uri === 'file:///t/reopened.hlsl' ? workspace : undefined;
      },
      async workspaceForOrCreateFile(uri: string) {
        return this.workspaceFor(uri);
      },
    } as never;

    registerDocuments(harness.connection, manager);
    harness.open({
      textDocument: {
        uri: 'file:///t/reopened.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 Stale() { return 0; }',
      },
    });
    harness.close({ textDocument: { uri: 'file:///t/reopened.hlsl' } });
    harness.open({
      textDocument: {
        uri: 'file:///t/reopened.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 Fresh() { return 0; }',
      },
    });
    allowStaleReindex();

    await waitFor(() => calls.includes('store:float4 Fresh() { return 0; }'));

    expect(calls).toContain('close:file:///t/reopened.hlsl');
    expect(calls).toContain('store:float4 Fresh() { return 0; }');
    expect(calls).not.toContain('store:float4 Stale() { return 0; }');
  });
});
