import { describe, expect, it } from 'vitest';
import type {
  Connection,
  DocumentHighlight,
  DocumentHighlightParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerDocumentHighlightHandler } from '../../src/handlers/documentHighlight';

function captureDocumentHighlightHandler(): {
  connection: Connection;
  handler: () => ((params: DocumentHighlightParams) => Promise<DocumentHighlight[] | null>);
} {
  let handler: ((params: DocumentHighlightParams) => Promise<DocumentHighlight[] | null>) | undefined;
  const connection = {
    onDocumentHighlight(fn: (params: DocumentHighlightParams) => Promise<DocumentHighlight[] | null>) {
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;

  return {
    connection,
    handler: () => {
      if (!handler) throw new Error('document highlight handler was not registered');
      return handler;
    },
  };
}

describe('registerDocumentHighlightHandler', () => {
  it('reindexes an open document when the workspace store misses it', async () => {
    const { connection, handler } = captureDocumentHighlightHandler();
    const uri = 'file:///project/Assets/Live.hlsl';
    const text = 'float4 Live() { return 1; }';
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const store = new IndexStore();
    let reindexCalls = 0;
    const workspace = {
      includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
      store,
      global: new GlobalSymbolIndex(),
      globalRefs: new GlobalReferenceIndex(),
      async reindex(requestedUri: string, requestedText: string) {
        reindexCalls++;
        const index: FileIndex = { uri: requestedUri, symbols: [], references: [] };
        expect(requestedUri).toBe(uri);
        expect(requestedText).toBe(text);
        store.set(uri, index);
      },
    };
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    } as never;

    registerDocumentHighlightHandler(connection, documents, manager);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 7 },
    });

    expect(reindexCalls).toBe(1);
    expect(result).toBeNull();
  });
});
