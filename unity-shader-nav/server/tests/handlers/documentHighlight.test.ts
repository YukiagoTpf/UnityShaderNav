import { describe, expect, it } from 'vitest';
import type {
  Connection,
  DocumentHighlight,
  DocumentHighlightParams,
} from 'vscode-languageserver/node';
import { DocumentHighlightKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex, Range } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerDocumentHighlightHandler } from '../../src/handlers/documentHighlight';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

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

async function createHighlightFixture(
  uri: string,
  languageId: string,
  text: string,
): Promise<{
  handler: (params: DocumentHighlightParams) => Promise<DocumentHighlight[] | null>;
  index: FileIndex;
}> {
  const { connection, handler } = captureDocumentHighlightHandler();
  const doc = TextDocument.create(uri, languageId, 1, text);
  const index = await indexFile(uri, text);
  const store = new IndexStore();
  store.set(uri, index);
  const global = new GlobalSymbolIndex();
  const globalRefs = new GlobalReferenceIndex();
  global.upsert(index);
  globalRefs.upsert(index);
  const documents = {
    get(requestedUri: string) {
      return requestedUri === uri ? doc : undefined;
    },
  } as never;
  const workspace = {
    includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
    store,
    global,
    globalRefs,
    isInPackages: () => false,
  };
  const manager = {
    async workspaceForOrCreateFile(requestedUri: string) {
      return requestedUri === uri ? workspace : undefined;
    },
  } as never;

  registerDocumentHighlightHandler(connection, documents, manager);

  return { handler: handler(), index };
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

function rangeKey(range: Range): string {
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

function expectHighlights(result: DocumentHighlight[] | null, ranges: Range[]): void {
  expect(result?.map((highlight) => ({
    range: highlight.range,
    kind: highlight.kind,
  }))).toEqual(ranges.map((range) => ({
    range,
    kind: DocumentHighlightKind.Text,
  })));
}

function rangeOfToken(text: string, line: number, token: string, occurrence = 0): Range {
  const start = tokenPosition(text, line, token, occurrence);
  return {
    start,
    end: { line, character: start.character + token.length },
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

  it('highlights local variable declaration and same-scope usages only', async () => {
    const uri = 'file:///project/Assets/ScopedLocals.hlsl';
    const text = [
      'float First() {',
      '  float i = 1;',
      '  i = i + 1;',
      '  return i;',
      '}',
      'float Second() {',
      '  float i = 2;',
      '  i = i + 1;',
      '  return i;',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const firstLocal = index.symbols.find(
      (symbol) => symbol.name === 'i' && symbol.kind === 'localVariable' && symbol.scope === 'First',
    );
    if (!firstLocal?.scopeRange) throw new Error('missing First.i local');
    const references = index.references
      .filter((reference) =>
        reference.name === 'i' &&
        reference.context === 'identifier' &&
        reference.location.range.start.line >= firstLocal.scopeRange!.start.line &&
        reference.location.range.start.line <= firstLocal.scopeRange!.end.line,
      )
      .map((reference) => reference.location.range);

    const result = await handler({
      textDocument: { uri },
      position: { line: 2, character: 2 },
    });

    expectHighlights(result, [firstLocal.location.range, ...references]);
  });

  it('highlights local variables when they are member receivers', async () => {
    const uri = 'file:///project/Assets/ReceiverLocalHighlights.hlsl';
    const text = [
      'struct InputData { float3 positionWS; float3 normalWS; };',
      'float4 frag() {',
      '  InputData inputData;',
      '  inputData = (InputData)0;',
      '  inputData.positionWS = 0;',
      '  inputData.normalWS = inputData.positionWS;',
      '  return 0;',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const local = index.symbols.find(
      (symbol) =>
        symbol.name === 'inputData' &&
        symbol.kind === 'localVariable',
    );
    if (!local) throw new Error('missing inputData local');

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 2, 'inputData'),
    });

    expectHighlights(result, [
      local.location.range,
      rangeOfToken(text, 3, 'inputData'),
      rangeOfToken(text, 4, 'inputData'),
      rangeOfToken(text, 5, 'inputData'),
      rangeOfToken(text, 5, 'inputData', 1),
    ]);
  });

  it('highlights function declaration and same-document calls', async () => {
    const uri = 'file:///project/Assets/Functions.hlsl';
    const text = [
      'float4 Helper() { return 1; }',
      'float4 Main() { return Helper(); }',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const declaration = index.symbols.find((symbol) => symbol.name === 'Helper' && symbol.kind === 'function');
    const call = index.references.find((reference) => reference.name === 'Helper' && reference.context === 'call');
    if (!declaration || !call) throw new Error('missing Helper declaration/call');

    const result = await handler({
      textDocument: { uri },
      position: { line: 1, character: text.split('\n')[1].indexOf('Helper') + 1 },
    });

    expectHighlights(result, [declaration.location.range, call.location.range]);
  });

  it('highlights struct declaration and same-document type references', async () => {
    const uri = 'file:///project/Assets/StructTypes.hlsl';
    const text = [
      'struct Customdata { float3 positionWS; };',
      'float4 Main(Customdata customdata) { return 1; }',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const declaration = index.symbols.find((symbol) => symbol.name === 'Customdata' && symbol.kind === 'struct');
    const typeRef = index.references.find((reference) => reference.name === 'Customdata' && reference.context === 'type');
    if (!declaration || !typeRef) throw new Error('missing Customdata declaration/type ref');

    const result = await handler({
      textDocument: { uri },
      position: { line: 1, character: text.split('\n')[1].indexOf('Customdata') + 1 },
    });

    expectHighlights(result, [declaration.location.range, typeRef.location.range]);
  });

  it('highlights struct type references in variable declarations and casts', async () => {
    const uri = 'file:///project/Assets/StructCastTypes.hlsl';
    const text = [
      'struct InputData { float3 positionWS; };',
      'float4 frag() {',
      '  InputData inputData;',
      '  inputData = (InputData)0;',
      '  return 0;',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const declaration = index.symbols.find((symbol) => symbol.name === 'InputData' && symbol.kind === 'struct');
    const typeRefs = index.references
      .filter((reference) => reference.name === 'InputData' && reference.context === 'type')
      .map((reference) => reference.location.range);
    if (!declaration || typeRefs.length !== 2) throw new Error('missing InputData type references');

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 2, 'InputData'),
    });

    expectHighlights(result, [declaration.location.range, ...typeRefs]);
  });

  it('highlights macro declaration and macro calls without local variable noise', async () => {
    const uri = 'file:///project/Assets/Macros.hlsl';
    const text = [
      '#define SAMPLE_TEXTURE2D(tex, sampler, uv) tex.Sample(sampler, uv)',
      'float4 Use(float2 uv) {',
      '  return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);',
      '}',
      'float Noise() {',
      '  float SAMPLE_TEXTURE2D = 0;',
      '  SAMPLE_TEXTURE2D = SAMPLE_TEXTURE2D + 1;',
      '  return SAMPLE_TEXTURE2D;',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const macro = index.symbols.find((symbol) => symbol.name === 'SAMPLE_TEXTURE2D' && symbol.kind === 'macro');
    const call = index.references.find(
      (reference) => reference.name === 'SAMPLE_TEXTURE2D' && reference.context === 'call',
    );
    if (!macro || !call) throw new Error('missing macro declaration/call');

    const result = await handler({
      textDocument: { uri },
      position: { line: 2, character: text.split('\n')[2].indexOf('SAMPLE_TEXTURE2D') + 1 },
    });

    expectHighlights(result, [macro.location.range, call.location.range]);
  });

  it('returns null for identifiers in comments and strings', async () => {
    const uri = 'file:///project/Assets/Context.hlsl';
    const text = [
      'float4 helper(float4 v) { return v; }',
      '// helper should not highlight from a comment',
      'float4 main() { const char* s = "helper"; return helper(0); }',
    ].join('\n');
    const { handler } = await createHighlightFixture(uri, 'hlsl', text);

    await expect(handler({
      textDocument: { uri },
      position: { line: 1, character: 4 },
    })).resolves.toBeNull();
    await expect(handler({
      textDocument: { uri },
      position: { line: 2, character: text.split('\n')[2].indexOf('"helper"') + 2 },
    })).resolves.toBeNull();
  });

  it('rejects ShaderLab properties and tags while highlighting inside HLSLPROGRAM blocks', async () => {
    const uri = 'file:///project/Assets/Surface.shader';
    const text = [
      'Shader "T/Test" {',
      '  Properties { helper ("helper", Float) = 0 }',
      '  SubShader {',
      '    Tags { "RenderType"="helper" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 helper(float4 v) { return v; }',
      '      float4 main() { return helper(0); }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'shaderlab', text);
    const declaration = index.symbols.find((symbol) => symbol.name === 'helper' && symbol.kind === 'function');
    const call = index.references.find((reference) => reference.name === 'helper' && reference.context === 'call');
    if (!declaration || !call) throw new Error('missing shader helper declaration/call');

    await expect(handler({
      textDocument: { uri },
      position: tokenPosition(text, 1, 'helper'),
    })).resolves.toBeNull();
    await expect(handler({
      textDocument: { uri },
      position: tokenPosition(text, 3, 'helper'),
    })).resolves.toBeNull();

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 7, 'helper'),
    });

    expectHighlights(result, [declaration.location.range, call.location.range]);
  });

  it('highlights receiver-typed struct members without mixing same-name members', async () => {
    const uri = 'file:///project/Assets/MemberHighlights.hlsl';
    const text = [
      'struct InputData { float3 positionWS; };',
      'struct Varyings { float4 positionWS; };',
      'float4 frag(Varyings i) {',
      '  InputData inputData;',
      '  inputData.positionWS = i.positionWS;',
      '  return inputData.positionWS.x + i.positionWS.x;',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const inputMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'InputData',
    );
    const inputRefs = index.references
      .filter((reference) =>
        reference.name === 'positionWS' &&
        reference.context === 'member' &&
        reference.receiver === 'inputData',
      )
      .map((reference) => reference.location.range);
    if (!inputMember || inputRefs.length !== 2) throw new Error('missing InputData.positionWS highlights');

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 4, 'positionWS'),
    });

    expectHighlights(result, [inputMember.location.range, ...inputRefs]);
  });

  it('highlights struct member references from the member declaration position', async () => {
    const uri = 'file:///project/Assets/MemberDeclarationHighlights.hlsl';
    const text = [
      'struct InputData { float3 positionWS; };',
      'struct Varyings { float4 positionWS; };',
      'float4 frag(InputData inputData) {',
      '  return inputData.positionWS;',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'hlsl', text);
    const inputMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'InputData',
    );
    const inputRef = index.references.find(
      (reference) =>
        reference.name === 'positionWS' &&
        reference.context === 'member' &&
        reference.receiver === 'inputData',
    );
    if (!inputMember || !inputRef) throw new Error('missing InputData.positionWS declaration fixture');

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 0, 'positionWS'),
    });

    expectHighlights(result, [inputMember.location.range, inputRef.location.range]);
  });

  it('returns null for unresolved member receivers instead of broad same-name member highlights', async () => {
    const uri = 'file:///project/Assets/UnresolvedMemberHighlights.hlsl';
    const text = [
      'struct InputData { float3 positionWS; };',
      'struct Varyings { float4 positionWS; };',
      'float4 frag() {',
      '  return unknown.positionWS;',
      '}',
    ].join('\n');
    const { handler } = await createHighlightFixture(uri, 'hlsl', text);

    await expect(handler({
      textDocument: { uri },
      position: tokenPosition(text, 3, 'positionWS'),
    })).resolves.toBeNull();
  });

  it('falls back to same resolved receiver member highlights when external member declarations are missing', async () => {
    const uri = 'file:///project/Assets/ExternalMemberHighlights.hlsl';
    const text = [
      'struct Varyings { float4 positionWS; };',
      'float4 frag(Varyings i) {',
      '  InputData inputData;',
      '  inputData = (InputData)0;',
      '  inputData.positionWS = i.positionWS;',
      '  inputData.shadowCoord = TransformWorldToShadowCoord(i.positionWS);',
      '  return inputData.positionWS.x;',
      '}',
    ].join('\n');
    const { handler } = await createHighlightFixture(uri, 'hlsl', text);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 4, 'positionWS'),
    });

    expectHighlights(result, [
      rangeOfToken(text, 4, 'positionWS'),
      rangeOfToken(text, 6, 'positionWS'),
    ]);
  });

  it('does not fall back when the unresolved member receiver is not a variable', async () => {
    const uri = 'file:///project/Assets/NonVariableReceiverHighlights.hlsl';
    const text = [
      'struct InputData { };',
      'float4 frag() {',
      '  InputData.positionWS;',
      '  InputData.positionWS;',
      '  return 0;',
      '}',
    ].join('\n');
    const { handler } = await createHighlightFixture(uri, 'hlsl', text);

    await expect(handler({
      textDocument: { uri },
      position: tokenPosition(text, 2, 'positionWS'),
    })).resolves.toBeNull();
  });

  it('highlights receiver-typed members inside shader HLSL blocks with Unity struct macros', async () => {
    const uri = 'file:///project/Assets/MacroStruct.shader';
    const text = [
      'Shader "T/MacroStruct" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      struct InputData { float3 positionWS; };',
      '      struct v2f {',
      '        UNITY_VERTEX_INPUT_INSTANCE_ID',
      '        UNITY_VERTEX_OUTPUT_STEREO',
      '        float4 positionWS : TEXCOORD0;',
      '      };',
      '      float4 frag(v2f i) : SV_Target {',
      '        InputData inputData;',
      '        inputData.positionWS = i.positionWS.xyz;',
      '        return float4(inputData.positionWS, 1);',
      '      }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { handler, index } = await createHighlightFixture(uri, 'shaderlab', text);
    const inputMember = index.symbols.find(
      (symbol) =>
        symbol.name === 'positionWS' &&
        symbol.kind === 'structMember' &&
        symbol.parentType === 'InputData',
    );
    const inputRefs = index.references
      .filter((reference) =>
        reference.name === 'positionWS' &&
        reference.context === 'member' &&
        reference.receiver === 'inputData',
      )
      .map((reference) => reference.location.range);
    if (!inputMember || inputRefs.length !== 2) {
      throw new Error('missing shader InputData.positionWS highlights');
    }

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 12, 'positionWS'),
    });

    expectHighlights(result, [inputMember.location.range, ...inputRefs]);
  });
});
