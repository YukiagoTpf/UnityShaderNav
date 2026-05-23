import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, DefinitionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerDefinitionHandler } from '../../src/handlers/definition';
import type { IncludeContext } from '../../src/include';

const root = resolve(__dirname, '../include/fixtures/projectA');

describe('registerDefinitionHandler: include definitions', () => {
  it('returns a location link for the include path under the cursor', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const warnings: string[] = [];
    const connection = {
      console: {
        warn(message: string) {
          warnings.push(message);
        },
      },
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const filePath = join(root, 'Assets/Shaders/Main.shader');
    const uri = pathToFileURL(filePath).href;
    const text = [
      'Shader "T/Inc" {',
      '  HLSLPROGRAM',
      '  #include "Common.hlsl"',
      '  ENDHLSL',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'shaderlab', 1, text);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const includeCtx: IncludeContext = { unityProjectRoot: root, includeDirectories: [] };
    const workspace = {
      includeCtx,
      store: new IndexStore(),
      global: new GlobalSymbolIndex(),
    };
    const manager = {
      workspaceFor(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
      async workspaceForOrCreateFile(requestedUri: string) {
        return this.workspaceFor(requestedUri);
      },
    } as never;

    registerDefinitionHandler(
      connection,
      documents,
      manager,
    );

    const result = await handler?.({
      textDocument: { uri },
      position: { line: 2, character: 14 },
    }) as Array<{ targetUri: string }> | null | undefined;

    expect(result).toHaveLength(1);
    expect(result?.[0].targetUri).toBe(
      pathToFileURL(join(root, 'Assets/Shaders/Common.hlsl')).href,
    );
    expect(warnings).toEqual([]);
  });

  it('does not resolve include paths inside multi-line block comments', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const connection = {
      console: {
        warn() {},
      },
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const filePath = join(root, 'Assets/Shaders/Main.shader');
    const uri = pathToFileURL(filePath).href;
    const text = [
      'Shader "T/Inc" {',
      '  HLSLPROGRAM',
      '  /*',
      '  #include "Common.hlsl"',
      '  */',
      '  ENDHLSL',
      '}',
    ].join('\n');
    const doc = TextDocument.create(uri, 'shaderlab', 1, text);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const workspace = {
      includeCtx: { unityProjectRoot: root, includeDirectories: [] },
      store: new IndexStore(),
      global: new GlobalSymbolIndex(),
    };
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
      position: { line: 3, character: 14 },
    });

    expect(result).toBeNull();
  });
});
