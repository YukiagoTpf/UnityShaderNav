import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import { IndexStore } from '../../src/index';
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
  it('indexes opened documents and removes closed documents', async () => {
    const store = new IndexStore();
    const harness = createConnectionHarness();

    registerDocuments(harness.connection, store);
    harness.open({
      textDocument: {
        uri: 'file:///t/doc.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 helper(float4 v) { return v; }',
      },
    });

    await waitFor(() => (store.get('file:///t/doc.hlsl')?.symbols.length ?? 0) > 0);

    harness.close({ textDocument: { uri: 'file:///t/doc.hlsl' } });

    expect(store.get('file:///t/doc.hlsl')).toBeUndefined();
  });

  it('indexes an opened document once', async () => {
    const store = new IndexStore();
    const harness = createConnectionHarness();

    registerDocuments(harness.connection, store);
    harness.open({
      textDocument: {
        uri: 'file:///t/once.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 helper(float4 v) { return v; }',
      },
    });

    await waitFor(() => harness.logs.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.logs).toHaveLength(1);
  });

  it('does not restore an index after the document closes during indexing', async () => {
    const store = new IndexStore();
    const harness = createConnectionHarness();

    registerDocuments(harness.connection, store);
    harness.open({
      textDocument: {
        uri: 'file:///t/closed.hlsl',
        languageId: 'hlsl',
        version: 1,
        text: 'float4 helper(float4 v) { return v; }',
      },
    });
    harness.close({ textDocument: { uri: 'file:///t/closed.hlsl' } });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(store.get('file:///t/closed.hlsl')).toBeUndefined();
  });
});
