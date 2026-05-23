import { describe, expect, it } from 'vitest';
import type { Connection, DefinitionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerDefinitionHandler } from '../../src/handlers/definition';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';

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

  it('waits for RequestSuspender release before resolving definitions', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const connection = {
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const uri = 'file:///t/x.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 main() { return 0; }');
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const workspace = {
      includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
      store: new IndexStore(),
      global: new GlobalSymbolIndex(),
    };
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();

    registerDefinitionHandler(connection, documents, manager, suspender);

    const promise = handler?.({
      textDocument: { uri },
      position: { line: 0, character: 7 },
    });
    let settled = false;
    void promise?.then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(settled).toBe(false);
    suspender.release();
    await expect(promise).resolves.toBeNull();
  });

  it('uses member receiver type to disambiguate struct members', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const connection = {
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const uri = 'file:///t/use.hlsl';
    const doc = TextDocument.create(
      uri,
      'hlsl',
      1,
      'float3 main(Surface surface) { return surface.positionWS; }',
    );
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        {
          name: 'surface',
          kind: 'parameter',
          declaredType: 'Surface',
          scopeRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 58 } },
          location: {
            uri,
            range: { start: { line: 0, character: 20 }, end: { line: 0, character: 27 } },
          },
        },
      ],
    };
    const workspace = {
      includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
      store: new IndexStore(),
      global: new GlobalSymbolIndex(),
    };
    workspace.store.set(uri, idx);
    workspace.global.upsert({
      uri: 'file:///t/Surface.hlsl',
      references: [],
      symbols: [
        {
          name: 'positionWS',
          kind: 'structMember',
          parentType: 'Surface',
          location: {
            uri: 'file:///t/Surface.hlsl',
            range: { start: { line: 1, character: 11 }, end: { line: 1, character: 21 } },
          },
        },
      ],
    });
    workspace.global.upsert({
      uri: 'file:///t/Other.hlsl',
      references: [],
      symbols: [
        {
          name: 'positionWS',
          kind: 'structMember',
          parentType: 'Other',
          location: {
            uri: 'file:///t/Other.hlsl',
            range: { start: { line: 1, character: 11 }, end: { line: 1, character: 21 } },
          },
        },
      ],
    });
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;

    registerDefinitionHandler(connection, documents, manager);

    const result = await handler?.({
      textDocument: { uri },
      position: { line: 0, character: 48 },
    }) as LocationLink[] | null;

    expect(result).toHaveLength(1);
    expect(result?.[0].targetUri).toBe('file:///t/Surface.hlsl');
    expect(result?.[0].originSelectionRange).toEqual({
      start: { line: 0, character: 46 },
      end: { line: 0, character: 56 },
    });
  });
});
