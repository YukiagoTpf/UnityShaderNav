import { describe, expect, it } from 'vitest';
import type { Connection, DefinitionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerDefinitionHandler } from '../../src/handlers/definition';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';

function createDefinitionFixture(
  uri: string,
  languageId: string,
  text: string,
  idx: FileIndex,
): { handler: (params: DefinitionParams) => Promise<unknown> } {
  let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
  const connection = {
    onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
      handler = fn;
      return { dispose() {} };
    },
    console: {
      warn() {},
    },
  } as unknown as Connection;
  const doc = TextDocument.create(uri, languageId, 1, text);
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
  workspace.store.set(uri, idx);
  const manager = {
    async workspaceForOrCreateFile(requestedUri: string) {
      return requestedUri === uri ? workspace : undefined;
    },
  } as never;

  registerDefinitionHandler(connection, documents, manager);
  if (!handler) throw new Error('definition handler was not registered');
  return { handler };
}

function helperIndex(uri: string, text: string): FileIndex {
  const lines = text.split(/\r?\n/);
  const line = lines.findIndex((candidate) => candidate.includes('float4 helper'));
  if (line < 0) throw new Error('fixture is missing helper declaration');
  const character = lines[line].indexOf('helper');
  return {
    uri,
    symbols: [
      {
        name: 'helper',
        kind: 'function',
        location: {
          uri,
          range: { start: { line, character }, end: { line, character: character + 'helper'.length } },
        },
      },
    ],
    references: [],
  };
}

function memberIndex(uri: string): FileIndex {
  return {
    uri,
    references: [],
    symbols: [
      {
        name: 'surface',
        kind: 'parameter',
        declaredType: 'Surface',
        scopeRange: { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } },
        location: {
          uri,
          range: { start: { line: 0, character: 20 }, end: { line: 0, character: 27 } },
        },
      },
      {
        name: 'positionWS',
        kind: 'structMember',
        parentType: 'Surface',
        location: {
          uri,
          range: { start: { line: 0, character: 35 }, end: { line: 0, character: 45 } },
        },
      },
    ],
  };
}

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

  it('reindexes the open document on demand when the store misses', async () => {
    let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
    const connection = {
      onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const uri = 'file:///t/live.hlsl';
    const text = [
      'float4 helper(float4 v) { return v; }',
      'float4 main() { return helper(float4(1,1,1,1)); }',
    ].join('\n');
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const workspace = {
      includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
      store: new IndexStore(),
      global: new GlobalSymbolIndex(),
      async reindex(requestedUri: string, requestedText: string) {
        const idx = helperIndex(requestedUri, requestedText);
        this.store.set(requestedUri, idx);
        this.global.upsert(idx);
      },
    };
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;

    registerDefinitionHandler(connection, documents, manager);

    const result = await handler?.({
      textDocument: { uri },
      position: { line: 1, character: 25 },
    }) as LocationLink[] | null;

    expect(result).toHaveLength(1);
    expect(result?.[0].targetUri).toBe(uri);
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

  it('returns null for generic identifiers inside hlsl line comments', async () => {
    const uri = 'file:///t/comment.hlsl';
    const text = [
      'float4 helper(float4 v) { return v; }',
      '// helper should not jump from a comment',
    ].join('\n');
    const { handler } = createDefinitionFixture(uri, 'hlsl', text, helperIndex(uri, text));

    await expect(handler({
      textDocument: { uri },
      position: { line: 1, character: 4 },
    })).resolves.toBeNull();
  });

  it('returns null for generic identifiers inside hlsl block comments', async () => {
    const uri = 'file:///t/block-comment.hlsl';
    const text = [
      'float4 helper(float4 v) { return v; }',
      '/*',
      ' * helper should not jump from a block comment',
      ' */',
    ].join('\n');
    const { handler } = createDefinitionFixture(uri, 'hlsl', text, helperIndex(uri, text));

    await expect(handler({
      textDocument: { uri },
      position: { line: 2, character: 4 },
    })).resolves.toBeNull();
  });

  it('returns null for generic identifiers inside hlsl string literals', async () => {
    const uri = 'file:///t/string.hlsl';
    const text = [
      'float4 helper(float4 v) { return v; }',
      'float4 main() { const char* s = "helper"; return helper(0); }',
    ].join('\n');
    const { handler } = createDefinitionFixture(uri, 'hlsl', text, helperIndex(uri, text));

    await expect(handler({
      textDocument: { uri },
      position: { line: 1, character: 35 },
    })).resolves.toBeNull();
  });

  it('returns null for generic identifiers in shaderlab properties and tags', async () => {
    const uri = 'file:///t/surface.shader';
    const text = [
      'Shader "T/Test" {',
      '  Properties {',
      '    helper ("helper", Float) = 0',
      '  }',
      '  SubShader {',
      '    Tags { "RenderType"="helper" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 helper(float4 v) { return v; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { handler } = createDefinitionFixture(uri, 'shaderlab', text, helperIndex(uri, text));

    await expect(handler({
      textDocument: { uri },
      position: { line: 2, character: 5 },
    })).resolves.toBeNull();
    await expect(handler({
      textDocument: { uri },
      position: { line: 5, character: 27 },
    })).resolves.toBeNull();
  });

  it('returns null for shaderlab properties inside commented-out hlsl directives', async () => {
    const uri = 'file:///t/commented-directives.shader';
    const text = [
      'Shader "T/Test" {',
      '  /*',
      '  HLSLPROGRAM',
      '  */',
      '  Properties { helper ("helper", Float) = 0 }',
      '  ENDHLSL',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 helper(float4 v) { return v; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { handler } = createDefinitionFixture(uri, 'shaderlab', text, helperIndex(uri, text));

    await expect(handler({
      textDocument: { uri },
      position: { line: 4, character: 15 },
    })).resolves.toBeNull();
  });

  it('returns null for member access inside hlsl line comments', async () => {
    const uri = 'file:///t/comment-member.hlsl';
    const text = [
      'float3 main(Surface surface) { return 0; }',
      '// surface.positionWS should not jump from a comment',
    ].join('\n');
    const { handler } = createDefinitionFixture(uri, 'hlsl', text, memberIndex(uri));

    await expect(handler({
      textDocument: { uri },
      position: { line: 1, character: 13 },
    })).resolves.toBeNull();
  });

  it('returns null for member access in shaderlab properties outside hlsl blocks', async () => {
    const uri = 'file:///t/property-member.shader';
    const text = [
      'Shader "T/Test" {',
      '  Properties {',
      '    surface.positionWS ("surface.positionWS", Float) = 0',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float3 main(Surface surface) { return surface.positionWS; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { handler } = createDefinitionFixture(uri, 'shaderlab', text, memberIndex(uri));

    await expect(handler({
      textDocument: { uri },
      position: { line: 2, character: 14 },
    })).resolves.toBeNull();
  });

  it('still resolves generic identifiers inside shaderlab hlsl blocks', async () => {
    const uri = 'file:///t/surface.shader';
    const text = [
      'Shader "T/Test" {',
      '  Properties { helper ("helper", Float) = 0 }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 helper(float4 v) { return v; }',
      '      float4 main() { return helper(0); }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = helperIndex(uri, text);
    const { handler } = createDefinitionFixture(uri, 'shaderlab', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: { line: 6, character: 31 },
    });

    expect(result).toEqual([
      {
        targetUri: uri,
        targetRange: idx.symbols[0].location.range,
        targetSelectionRange: idx.symbols[0].location.range,
        originSelectionRange: {
          start: { line: 6, character: 29 },
          end: { line: 6, character: 35 },
        },
      },
    ]);
  });
});
