import { describe, expect, it } from 'vitest';
import type { Connection, DocumentSymbolParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { IndexStore } from '../../src/index';
import { registerDocumentSymbolHandler } from '../../src/handlers/documentSymbol';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';

describe('registerDocumentSymbolHandler', () => {
  it('returns document symbols for the requested indexed document', async () => {
    let handler: ((params: DocumentSymbolParams) => unknown) | undefined;
    const connection = {
      onDocumentSymbol(fn: (params: DocumentSymbolParams) => unknown) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const uri = 'file:///t/x.hlsl';
    const idx: FileIndex = {
      uri,
      symbols: [{
        name: 'main',
        kind: 'function',
        location: {
          uri,
          range: {
            start: { line: 0, character: 7 },
            end: { line: 0, character: 11 },
          },
        },
      }],
      references: [],
    };
    const workspace = { index: { store: new IndexStore() } };
    workspace.index.store.set(uri, idx);
    const manager = {
      async workspaceForOrCreateFile(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    } as never;

    registerDocumentSymbolHandler(connection, {} as never, manager);

    const result = handler?.({ textDocument: { uri } });

    await expect(result).resolves.toMatchObject([{ name: 'main' }]);
  });

  it('waits for the request suspender to release before resolving', async () => {
    let handler: ((params: DocumentSymbolParams) => unknown) | undefined;
    const connection = {
      onDocumentSymbol(fn: (params: DocumentSymbolParams) => unknown) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const uri = 'file:///t/x.hlsl';
    const idx: FileIndex = {
      uri,
      symbols: [{
        name: 'main',
        kind: 'function',
        location: {
          uri,
          range: {
            start: { line: 0, character: 7 },
            end: { line: 0, character: 11 },
          },
        },
      }],
      references: [],
    };
    const workspace = { index: { store: new IndexStore() } };
    workspace.index.store.set(uri, idx);
    const manager = {
      async workspaceForOrCreateFile(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    } as never;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();

    registerDocumentSymbolHandler(connection, {} as never, manager, suspender);

    let resolved = false;
    const result = handler?.({ textDocument: { uri } }) as Promise<unknown>;
    void result.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);

    suspender.release();

    await expect(result).resolves.toMatchObject([{ name: 'main' }]);
  });

  it('indexes the open document on demand when the store is not ready yet', async () => {
    let handler: ((params: DocumentSymbolParams) => unknown) | undefined;
    const connection = {
      onDocumentSymbol(fn: (params: DocumentSymbolParams) => unknown) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const uri = 'file:///t/live.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 LiveOutline() { return 0; }');
    const store = new IndexStore();
    const workspace = {
      index: {
        store,
        async reindex(requestedUri: string) {
        const idx: FileIndex = {
          uri: requestedUri,
          symbols: [{
            name: 'LiveOutline',
            kind: 'function',
            location: {
              uri: requestedUri,
              range: {
                start: { line: 0, character: 7 },
                end: { line: 0, character: 18 },
              },
            },
          }],
          references: [],
        };
        store.set(requestedUri, idx);
        },
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

    registerDocumentSymbolHandler(connection, documents, manager);

    const result = handler?.({ textDocument: { uri } });

    await expect(result).resolves.toMatchObject([{ name: 'LiveOutline' }]);
  });
});
