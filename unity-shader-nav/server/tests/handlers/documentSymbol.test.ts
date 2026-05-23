import { describe, expect, it } from 'vitest';
import type { Connection, DocumentSymbolParams } from 'vscode-languageserver/node';
import type { FileIndex } from '@unity-shader-nav/shared';
import { IndexStore } from '../../src/index';
import { registerDocumentSymbolHandler } from '../../src/handlers/documentSymbol';

describe('registerDocumentSymbolHandler', () => {
  it('returns document symbols for the requested indexed document', () => {
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
    const workspace = { store: new IndexStore() };
    workspace.store.set(uri, idx);
    const manager = {
      workspaceFor(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    } as never;

    registerDocumentSymbolHandler(connection, {} as never, manager);

    const result = handler?.({ textDocument: { uri } });

    expect(result).toMatchObject([{ name: 'main' }]);
  });
});
