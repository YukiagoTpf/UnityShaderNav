import { describe, expect, it } from 'vitest';
import type {
  Connection,
  SemanticTokens,
  SemanticTokensParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerSemanticTokensHandler, SEMANTIC_TOKEN_TYPES } from '../../src/handlers/semanticTokens';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

function captureSemanticTokensHandler(): {
  connection: Connection;
  handler: () => ((params: SemanticTokensParams) => Promise<SemanticTokens>);
} {
  let handler: ((params: SemanticTokensParams) => Promise<SemanticTokens>) | undefined;
  const connection = {
    languages: {
      semanticTokens: {
        on(fn: (params: SemanticTokensParams) => Promise<SemanticTokens>) {
          handler = fn;
          return { dispose() {} };
        },
      },
    },
  } as unknown as Connection;

  return {
    connection,
    handler: () => {
      if (!handler) throw new Error('semantic tokens handler was not registered');
      return handler;
    },
  };
}

function decodeTokens(tokens: SemanticTokens): Array<{
  line: number;
  character: number;
  length: number;
  type: string;
}> {
  const decoded: Array<{ line: number; character: number; length: number; type: string }> = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < tokens.data.length; i += 5) {
    line += tokens.data[i];
    character = tokens.data[i] === 0 ? character + tokens.data[i + 1] : tokens.data[i + 1];
    decoded.push({
      line,
      character,
      length: tokens.data[i + 2],
      type: SEMANTIC_TOKEN_TYPES[tokens.data[i + 3]],
    });
  }
  return decoded;
}

function expectSortedAndNonOverlapping(tokens: Array<{
  line: number;
  character: number;
  length: number;
}>): void {
  let previous: { line: number; character: number; length: number } | undefined;
  for (const token of tokens) {
    if (!previous) {
      previous = token;
      continue;
    }

    if (token.line === previous.line) {
      expect(token.character).toBeGreaterThanOrEqual(previous.character + previous.length);
    } else {
      expect(token.line).toBeGreaterThan(previous.line);
    }
    previous = token;
  }
}

describe('registerSemanticTokensHandler', () => {
  it('colors struct types, variables, members, functions, and macros', async () => {
    const { connection, handler } = captureSemanticTokensHandler();
    const uri = 'file:///project/Assets/Semantic.hlsl';
    const includeUri = 'file:///project/Assets/Includes/Macros.hlsl';
    const text = [
      '#define SAMPLE_TEXTURE2D(tex, sampler, uv) tex.Sample(sampler, uv)',
      'struct InputData { float3 positionWS; };',
      'float4 Helper(InputData inputData) {',
      '  inputData = (InputData)0;',
      '  inputData.positionWS = 0;',
      '  return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, inputData.positionWS);',
      '  return INCLUDED_MACRO(inputData.positionWS);',
      '}',
      'float4 LocalExample() {',
      '  InputData inputData;',
      '  return float4(inputData.positionWS, 1);',
      '}',
    ].join('\n');
    const includeText = '#define INCLUDED_MACRO(v) v';
    const doc = TextDocument.create(uri, 'hlsl', 1, text);
    const index = await indexFile(uri, text);
    const includeIndex = await indexFile(includeUri, includeText);
    const store = new IndexStore();
    store.set(uri, index);
    const global = new GlobalSymbolIndex();
    const globalRefs = new GlobalReferenceIndex();
    global.upsert(index);
    global.upsert(includeIndex);
    globalRefs.upsert(index);
    globalRefs.upsert(includeIndex);
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const workspace = {
      store,
      global,
      globalRefs,
    };
    const manager = {
      async workspaceForOrCreateFile(requestedUri: string) {
        return requestedUri === uri ? workspace : undefined;
      },
    } as never;

    registerSemanticTokensHandler(connection, documents, manager);

    const tokens = decodeTokens(await handler()({ textDocument: { uri } }));
    expectSortedAndNonOverlapping(tokens);
    expect(tokens).toEqual(expect.arrayContaining([
      { line: 0, character: 8, length: 'SAMPLE_TEXTURE2D'.length, type: 'macro' },
      { line: 1, character: 7, length: 'InputData'.length, type: 'type' },
      { line: 1, character: 26, length: 'positionWS'.length, type: 'property' },
      { line: 2, character: 7, length: 'Helper'.length, type: 'function' },
      { line: 2, character: 14, length: 'InputData'.length, type: 'type' },
      { line: 2, character: 24, length: 'inputData'.length, type: 'parameter' },
      { line: 3, character: 15, length: 'InputData'.length, type: 'type' },
      { line: 4, character: 12, length: 'positionWS'.length, type: 'property' },
      { line: 5, character: 9, length: 'SAMPLE_TEXTURE2D'.length, type: 'macro' },
      { line: 6, character: 9, length: 'INCLUDED_MACRO'.length, type: 'macro' },
      { line: 9, character: 2, length: 'InputData'.length, type: 'type' },
      { line: 9, character: 12, length: 'inputData'.length, type: 'variable' },
      { line: 10, character: 26, length: 'positionWS'.length, type: 'property' },
    ]));
  });
});
