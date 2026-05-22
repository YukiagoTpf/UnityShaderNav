import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import { registerDocuments } from '../../src/handlers/documents';

type OpenHandler = (event: {
  textDocument: { uri: string; languageId: string; version: number; text: string };
}) => void;
type CloseHandler = (event: { textDocument: { uri: string } }) => void;

function createConnectionHarness(): {
  connection: Connection;
  open: OpenHandler;
  close: CloseHandler;
  logs: string[];
} {
  let open: OpenHandler | undefined;
  let close: CloseHandler | undefined;
  const logs: string[] = [];
  const disposable = { dispose() {} };
  const connection = {
    console: { log(message: string) { logs.push(message); } },
    onDidOpenTextDocument(handler: OpenHandler) {
      open = handler;
      return disposable;
    },
    onDidChangeTextDocument() {
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
      async reindex(uri: string) {
        calls.push(`reindex:${uri}`);
      },
      closeDocument(uri: string) {
        calls.push(`close:${uri}`);
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
      async reindex(uri: string, _text: string, shouldStore: () => boolean) {
        await reindexStarted;
        if (shouldStore()) calls.push(`reindex:${uri}`);
      },
      closeDocument(uri: string) {
        calls.push(`close:${uri}`);
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
});
