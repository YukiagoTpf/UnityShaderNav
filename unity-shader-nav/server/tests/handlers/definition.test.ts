import { describe, expect, it } from 'vitest';
import type { Connection, DefinitionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerDefinitionHandler } from '../../src/handlers/definition';

describe('registerDefinitionHandler', () => {
  it('returns location links for the identifier under the cursor', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const connection = {
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const uri = 'file:///t/x.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, [
      'float4 helper(float4 v) { return v; }',
      'float4 main() { return helper(float4(1,1,1,1)); }',
    ].join('\n'));
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const idx: FileIndex = {
      uri,
      symbols: [
        {
          name: 'helper',
          kind: 'function',
          location: {
            uri,
            range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } },
          },
        },
      ],
      references: [],
    };
    const workspace = {
      includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
      store: new IndexStore(),
      global: new GlobalSymbolIndex(),
    };
    workspace.store.set(uri, idx);
    const manager = {
      workspaceFor(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
      async workspaceForOrCreateFile(requestedUri: string) {
        return this.workspaceFor(requestedUri);
      },
    } as never;

    registerDefinitionHandler(connection, documents, manager);

    const result = await handler?.({
      textDocument: { uri },
      position: { line: 1, character: 25 },
    });

    expect(result).toEqual([
      {
        targetUri: uri,
        targetRange: idx.symbols[0].location.range,
        targetSelectionRange: idx.symbols[0].location.range,
        originSelectionRange: {
          start: { line: 1, character: 23 },
          end: { line: 1, character: 29 },
        },
      },
    ]);
  });
});
