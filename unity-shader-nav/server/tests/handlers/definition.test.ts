import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, DefinitionParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerDefinitionHandler } from '../../src/handlers/definition';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

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

function tokenPosition(text: string, line: number, token: string, occurrence = 0): { line: number; character: number } {
  const lines = text.split(/\r?\n/);
  let character = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    character = lines[line].indexOf(token, from);
    if (character < 0) throw new Error(`missing token ${token} on line ${line}`);
    from = character + token.length;
  }
  return { line, character };
}

describe('registerDefinitionHandler', () => {
  it('filters global definition candidates to the transitive include chain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-1-def-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.hlsl');
      const sharedPath = join(assets, 'Shared.hlsl');
      const otherPath = join(assets, 'Other.hlsl');
      const mainText = [
        '#include "Shared.hlsl"',
        'float4 Main() { return Helper(); }',
      ].join('\n');
      const sharedText = 'float4 Helper() { return 1; }';
      const otherText = 'float4 Helper() { return 2; }';
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(sharedPath, sharedText, 'utf8');
      await writeFile(otherPath, otherText, 'utf8');

      const mainUri = pathToFileURL(mainPath).href;
      const sharedUri = pathToFileURL(sharedPath).href;
      const otherUri = pathToFileURL(otherPath).href;
      const mainIndex = await indexFile(mainUri, mainText);
      const sharedIndex = await indexFile(sharedUri, sharedText);
      const otherIndex = await indexFile(otherUri, otherText);
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const index of [mainIndex, sharedIndex, otherIndex]) {
        store.set(index.uri, index);
        global.upsert(index);
      }
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
      const doc = TextDocument.create(mainUri, 'hlsl', 1, mainText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === mainUri ? doc : undefined;
        },
      } as never;
      const workspace = {
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile(requestedUri: string) {
          return requestedUri === mainUri ? workspace : undefined;
        },
      } as never;
      const sharedHelper = sharedIndex.symbols.find(
        (symbol) => symbol.name === 'Helper' && symbol.kind === 'function',
      );
      if (!sharedHelper) throw new Error('missing Shared.Helper symbol');

      registerDefinitionHandler(connection, documents, manager);

      const result = await handler?.({
        textDocument: { uri: mainUri },
        position: { line: 1, character: mainText.split('\n')[1].indexOf('Helper') + 1 },
      }) as LocationLink[] | null;

      expect(result).toEqual([{
        targetUri: sharedUri,
        targetRange: sharedHelper.location.range,
        targetSelectionRange: sharedHelper.location.range,
        originSelectionRange: {
          start: { line: 1, character: 23 },
          end: { line: 1, character: 29 },
        },
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it('resolves a struct type identifier in a variable declaration', async () => {
    const uri = 'file:///t/issue2-customdata.hlsl';
    const text = [
      'struct Customdata {',
      '  half3 shadow;',
      '  half midtone;',
      '};',
      'float4 frag() {',
      '  Customdata customdata;',
      '  customdata.midtone = 1;',
      '  return float4(1, 1, 1, 1);',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const { handler } = createDefinitionFixture(uri, 'hlsl', text, index);
    const structSymbol = index.symbols.find(
      (symbol) => symbol.name === 'Customdata' && symbol.kind === 'struct',
    );
    const localSymbol = index.symbols.find(
      (symbol) => symbol.name === 'customdata' && symbol.kind === 'localVariable',
    );
    if (!structSymbol || !localSymbol) throw new Error('missing Customdata fixture symbols');

    const typeResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 5, 'Customdata'),
    }) as LocationLink[] | null;

    expect(typeResult).toHaveLength(1);
    expect(typeResult?.[0].targetUri).toBe(uri);
    expect(typeResult?.[0].targetRange).toEqual(structSymbol.location.range);
    expect(typeResult?.[0].originSelectionRange).toEqual({
      start: { line: 5, character: 2 },
      end: { line: 5, character: 12 },
    });

    const variableResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 5, 'customdata'),
    }) as LocationLink[] | null;

    expect(variableResult).toHaveLength(1);
    expect(variableResult?.[0].targetUri).toBe(uri);
    expect(variableResult?.[0].targetRange).toEqual(localSymbol.location.range);
    expect(variableResult?.[0].targetRange).not.toEqual(structSymbol.location.range);
  });

  it('resolves an include-visible struct type identifier in a variable declaration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-2-type-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.hlsl');
      const typesPath = join(assets, 'Types.hlsl');
      const mainText = [
        '#include "Types.hlsl"',
        'float4 frag() {',
        '  Customdata customdata;',
        '  return float4(1, 1, 1, 1);',
        '}',
      ].join('\n');
      const typesText = [
        'struct Customdata {',
        '  half midtone;',
        '};',
      ].join('\n');
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(typesPath, typesText, 'utf8');

      const uri = pathToFileURL(mainPath).href;
      const typesUri = pathToFileURL(typesPath).href;
      const indexes = await Promise.all([
        indexFile(uri, mainText),
        indexFile(typesUri, typesText),
      ]);
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const idx of indexes) {
        store.set(idx.uri, idx);
        global.upsert(idx);
      }
      const structSymbol = indexes[1].symbols.find(
        (symbol) => symbol.name === 'Customdata' && symbol.kind === 'struct',
      );
      if (!structSymbol) throw new Error('missing include Customdata symbol');
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
      const doc = TextDocument.create(uri, 'hlsl', 1, mainText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === uri ? doc : undefined;
        },
      } as never;
      const workspace = {
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile() {
          return workspace;
        },
      } as never;

      registerDefinitionHandler(connection, documents, manager);

      const result = await handler?.({
        textDocument: { uri },
        position: tokenPosition(mainText, 2, 'Customdata'),
      }) as LocationLink[] | null;

      expect(result).toHaveLength(1);
      expect(result?.[0].targetUri).toBe(typesUri);
      expect(result?.[0].targetRange).toEqual(structSymbol.location.range);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves an include-visible struct type identifier inside a shader hlsl block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-2-shader-type-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.shader');
      const typesPath = join(assets, 'Types.hlsl');
      const mainText = [
        'Shader "Test/Issue2" {',
        '  SubShader {',
        '    Pass {',
        '      HLSLPROGRAM',
        '      #include "Types.hlsl"',
        '      float4 frag() {',
        '        Customdata customdata;',
        '        return float4(1, 1, 1, 1);',
        '      }',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ].join('\n');
      const typesText = [
        'struct Customdata {',
        '  half midtone;',
        '};',
      ].join('\n');
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(typesPath, typesText, 'utf8');

      const uri = pathToFileURL(mainPath).href;
      const typesUri = pathToFileURL(typesPath).href;
      const indexes = await Promise.all([
        indexFile(uri, mainText),
        indexFile(typesUri, typesText),
      ]);
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const idx of indexes) {
        store.set(idx.uri, idx);
        global.upsert(idx);
      }
      const structSymbol = indexes[1].symbols.find(
        (symbol) => symbol.name === 'Customdata' && symbol.kind === 'struct',
      );
      if (!structSymbol) throw new Error('missing shader include Customdata symbol');
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
      const doc = TextDocument.create(uri, 'shaderlab', 1, mainText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === uri ? doc : undefined;
        },
      } as never;
      const workspace = {
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile() {
          return workspace;
        },
      } as never;

      registerDefinitionHandler(connection, documents, manager);

      const result = await handler?.({
        textDocument: { uri },
        position: tokenPosition(mainText, 6, 'Customdata'),
      }) as LocationLink[] | null;

      expect(result).toHaveLength(1);
      expect(result?.[0].targetUri).toBe(typesUri);
      expect(result?.[0].targetRange).toEqual(structSymbol.location.range);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses member receiver type to disambiguate struct members', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-member-def-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const usePath = join(assets, 'Use.hlsl');
      const surfacePath = join(assets, 'Surface.hlsl');
      const otherPath = join(assets, 'Other.hlsl');
      const useText = [
        '#include "Surface.hlsl"',
        'float3 main(Surface surface) { return surface.positionWS; }',
      ].join('\n');
      const surfaceText = [
        'struct Surface {',
        '  float3 positionWS;',
        '};',
      ].join('\n');
      const otherText = [
        'struct Other {',
        '  float3 positionWS;',
        '};',
      ].join('\n');
      await writeFile(usePath, useText, 'utf8');
      await writeFile(surfacePath, surfaceText, 'utf8');
      await writeFile(otherPath, otherText, 'utf8');

      const uri = pathToFileURL(usePath).href;
      const surfaceUri = pathToFileURL(surfacePath).href;
      const otherUri = pathToFileURL(otherPath).href;
      const indexes = await Promise.all([
        indexFile(uri, useText),
        indexFile(surfaceUri, surfaceText),
        indexFile(otherUri, otherText),
      ]);
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const index of indexes) {
        store.set(index.uri, index);
        global.upsert(index);
      }
      const surfaceMember = indexes[1].symbols.find(
        (symbol) =>
          symbol.name === 'positionWS' &&
          symbol.kind === 'structMember' &&
          symbol.parentType === 'Surface',
      );
      if (!surfaceMember) throw new Error('missing Surface.positionWS symbol');
      let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
      const connection = {
        onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
          handler = fn;
          return { dispose() {} };
        },
      } as unknown as Connection;
      const doc = TextDocument.create(uri, 'hlsl', 1, useText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === uri ? doc : undefined;
        },
      } as never;
      const workspace = {
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile() {
          return workspace;
        },
      } as never;

      registerDefinitionHandler(connection, documents, manager);

      const result = await handler?.({
        textDocument: { uri },
        position: { line: 1, character: 48 },
      }) as LocationLink[] | null;

      expect(result).toHaveLength(1);
      expect(result?.[0].targetUri).toBe(surfaceUri);
      expect(result?.[0].targetRange).toEqual(surfaceMember.location.range);
      expect(result?.[0].originSelectionRange).toEqual({
        start: { line: 1, character: 46 },
        end: { line: 1, character: 56 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves struct members through function parameter and local receivers', async () => {
    const uri = 'file:///t/issue2-member-receivers.hlsl';
    const text = [
      'struct Varyings {',
      '  float3 positionWS;',
      '};',
      '',
      'struct InputData {',
      '  float3 positionWS;',
      '  float4 shadowCoord;',
      '};',
      '',
      'float4 frag(Varyings i) {',
      '  InputData inputData;',
      '  inputData.positionWS = i.positionWS;',
      '  inputData.shadowCoord = float4(i.positionWS, 1);',
      '  return float4(1, 1, 1, 1);',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const { handler } = createDefinitionFixture(uri, 'hlsl', text, index);
    const varyingsMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'Varyings',
    );
    const inputDataMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'InputData',
    );
    if (!varyingsMember || !inputDataMember) throw new Error('missing receiver member symbols');

    const localReceiverResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 11, 'positionWS'),
    }) as LocationLink[] | null;

    expect(localReceiverResult).toHaveLength(1);
    expect(localReceiverResult?.[0].targetUri).toBe(uri);
    expect(localReceiverResult?.[0].targetRange).toEqual(inputDataMember.location.range);
    expect(localReceiverResult?.[0].originSelectionRange).toEqual({
      start: { line: 11, character: 12 },
      end: { line: 11, character: 22 },
    });

    const parameterReceiverResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 11, 'positionWS', 1),
    }) as LocationLink[] | null;

    expect(parameterReceiverResult).toHaveLength(1);
    expect(parameterReceiverResult?.[0].targetUri).toBe(uri);
    expect(parameterReceiverResult?.[0].targetRange).toEqual(varyingsMember.location.range);
    expect(parameterReceiverResult?.[0].originSelectionRange).toEqual({
      start: { line: 11, character: 27 },
      end: { line: 11, character: 37 },
    });
  });

  it('resolves locals and struct members after macro fields in a shader struct', async () => {
    const uri = 'file:///t/issue2-macro-struct.shader';
    const text = [
      'Shader "Test/Issue2MacroStruct" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      struct InputData {',
      '        float3 positionWS;',
      '      };',
      '      struct a2v {',
      '        float4 positionOS : POSITION;',
      '        UNITY_VERTEX_INPUT_INSTANCE_ID',
      '      };',
      '      struct v2f {',
      '        float3 positionWS : TEXCOORD1;',
      '        DECLARE_LIGHTMAP_OR_SH(staticLightmapUV, vertexSH, 8);',
      '      #ifdef DYNAMICLIGHTMAP_ON',
      '        float2 dynamicLightmapUV : TEXCOORD9;',
      '      #endif',
      '        float4 positionCS : SV_POSITION;',
      '        UNITY_VERTEX_INPUT_INSTANCE_ID',
      '        UNITY_VERTEX_OUTPUT_STEREO',
      '      };',
      '      half4 frag(v2f i) : SV_Target {',
      '        InputData inputData;',
      '        inputData = (InputData)0;',
      '        inputData.positionWS = i.positionWS;',
      '        return half4(1, 1, 1, 1);',
      '      }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const { handler } = createDefinitionFixture(uri, 'shaderlab', text, index);
    const localSymbol = index.symbols.find(
      (symbol) => symbol.name === 'inputData' && symbol.kind === 'localVariable',
    );
    const inputDataMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'InputData',
    );
    const v2fMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'v2f',
    );
    expect(localSymbol).toBeDefined();
    expect(inputDataMember).toBeDefined();
    expect(v2fMember).toBeDefined();
    if (!localSymbol || !inputDataMember || !v2fMember) return;

    const localResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 22, 'inputData'),
    }) as LocationLink[] | null;

    expect(localResult).toHaveLength(1);
    expect(localResult?.[0].targetRange).toEqual(localSymbol.location.range);

    const localMemberResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 24, 'positionWS'),
    }) as LocationLink[] | null;

    expect(localMemberResult).toHaveLength(1);
    expect(localMemberResult?.[0].targetRange).toEqual(inputDataMember.location.range);

    const parameterMemberResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 24, 'positionWS', 1),
    }) as LocationLink[] | null;

    expect(parameterMemberResult).toHaveLength(1);
    expect(parameterMemberResult?.[0].targetRange).toEqual(v2fMember.location.range);
  });

  it('resolves legacy CG global variable usages inside a shader CGPROGRAM block', async () => {
    const uri = 'file:///t/issue8-cg-legacy.shader';
    const text = [
      'Shader "Test/Issue8LegacyCG" {',
      '  SubShader {',
      '    Pass {',
      '      CGPROGRAM',
      '      sampler2D _MainTex;',
      '      fixed4 _Color;',
      '      half _Cutoff;',
      '      fixed4 frag() : SV_Target {',
      '        return tex2D(_MainTex, float2(0, 0)) * _Color * _Cutoff;',
      '      }',
      '      ENDCG',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const { handler } = createDefinitionFixture(uri, 'shaderlab', text, index);
    const expectedTargets = new Map([
      ['_MainTex', {
        symbol: index.symbols.find((symbol) => symbol.name === '_MainTex' && symbol.kind === 'variable'),
        declaredType: 'sampler2D',
      }],
      ['_Color', {
        symbol: index.symbols.find((symbol) => symbol.name === '_Color' && symbol.kind === 'variable'),
        declaredType: 'fixed4',
      }],
      ['_Cutoff', {
        symbol: index.symbols.find((symbol) => symbol.name === '_Cutoff' && symbol.kind === 'variable'),
        declaredType: 'half',
      }],
    ]);

    for (const [name, expected] of expectedTargets) {
      expect(expected.symbol).toBeDefined();
      expect(expected.symbol?.declaredType).toBe(expected.declaredType);
      if (!expected.symbol) continue;

      const result = await handler({
        textDocument: { uri },
        position: tokenPosition(text, 8, name),
      }) as LocationLink[] | null;

      expect(result).toHaveLength(1);
      expect(result?.[0].targetUri).toBe(uri);
      expect(result?.[0].targetRange).toEqual(expected.symbol.location.range);
    }
  });

  it('resolves issue 9 complex member chain shapes at the definition boundary', async () => {
    const uri = 'file:///t/issue9-chain-shapes.hlsl';
    const text = [
      'struct Light {',
      '  float3 color;',
      '};',
      'struct Brdf {',
      '  float roughness;',
      '};',
      'struct Surface {',
      '  Brdf brdfData;',
      '  float3 positionWS;',
      '};',
      'struct Settings {',
      '  float value;',
      '};',
      'Surface MakeSurface() { Surface s; return s; }',
      'cbuffer Params {',
      '  Settings settings;',
      '};',
      'float4 frag(Surface surface, Light lights[4], int i) {',
      '  surface = MakeSurface();',
      '  untypedSurface = MakeSurface();',
      '  float3 c = lights[i].color;',
      '  float r = surface.brdfData.roughness;',
      '  float v = settings.value;',
      '  float3 p = untypedSurface.positionWS;',
      '  return float4(c, r + v + p.x);',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const { handler } = createDefinitionFixture(uri, 'hlsl', text, index);
    const lightColor = index.symbols.find(
      (symbol) => symbol.name === 'color' && symbol.kind === 'structMember' && symbol.parentType === 'Light',
    );
    const brdfRoughness = index.symbols.find(
      (symbol) => symbol.name === 'roughness' && symbol.kind === 'structMember' && symbol.parentType === 'Brdf',
    );
    const settingsValue = index.symbols.find(
      (symbol) => symbol.name === 'value' && symbol.kind === 'structMember' && symbol.parentType === 'Settings',
    );
    const surfacePosition = index.symbols.find(
      (symbol) => symbol.name === 'positionWS' && symbol.kind === 'structMember' && symbol.parentType === 'Surface',
    );
    if (!lightColor || !brdfRoughness || !settingsValue || !surfacePosition) {
      throw new Error('missing issue 9 fixture members');
    }

    const arrayResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 20, 'color'),
    }) as LocationLink[] | null;
    const nestedResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 21, 'roughness'),
    }) as LocationLink[] | null;
    const cbufferResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 22, 'value'),
    }) as LocationLink[] | null;
    const rhsResult = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 23, 'positionWS'),
    }) as LocationLink[] | null;

    expect(arrayResult?.[0].targetRange).toEqual(lightColor.location.range);
    expect(nestedResult?.[0].targetRange).toEqual(brdfRoughness.location.range);
    expect(cbufferResult?.[0].targetRange).toEqual(settingsValue.location.range);
    expect(rhsResult?.[0].targetRange).toEqual(surfacePosition.location.range);
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
