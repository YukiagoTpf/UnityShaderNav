import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  GET_VARIANT_KEYWORDS_REQUEST,
  type GetVariantKeywordsParams,
  type GetVariantKeywordsResult,
} from '@unity-shader-nav/shared';
import { registerVariantKeywordsHandler } from '../../src/handlers/variantKeywords';

type RequestHandler = (params: GetVariantKeywordsParams) => GetVariantKeywordsResult;

function fakeConnection(): { connection: Connection; getHandler: () => RequestHandler } {
  let handler: RequestHandler | undefined;
  const connection = {
    onRequest(method: string, fn: RequestHandler) {
      expect(method).toBe(GET_VARIANT_KEYWORDS_REQUEST);
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    getHandler: () => {
      if (!handler) throw new Error('handler was not registered');
      return handler;
    },
  };
}

function documentsWith(uri: string, languageId: string, version: number, text: string) {
  const doc = TextDocument.create(uri, languageId, version, text);
  return {
    get(requestedUri: string) {
      return requestedUri === uri ? doc : undefined;
    },
  } as never;
}

describe('registerVariantKeywordsHandler', () => {
  it('returns variant keywords declared via #pragma multi_compile', () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/test.hlsl';
    const text = [
      '#pragma multi_compile _ FOO BAR',
      '#pragma multi_compile _ BAZ',
      'int x;',
    ].join('\n');
    registerVariantKeywordsHandler(connection, documentsWith(uri, 'hlsl', 1, text));
    const handler = getHandler();
    const result = handler({ textDocument: { uri } });
    expect(result.keywords.sort()).toEqual(['BAR', 'BAZ', 'FOO']);
  });

  it('returns empty array when no variant pragmas are present', () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/empty.hlsl';
    const text = 'int x = 1;';
    registerVariantKeywordsHandler(connection, documentsWith(uri, 'hlsl', 1, text));
    const handler = getHandler();
    const result = handler({ textDocument: { uri } });
    expect(result.keywords).toEqual([]);
  });

  it('drops the bare underscore placeholder', () => {
    const { connection, getHandler } = fakeConnection();
    const uri = 'file:///t/underscore.hlsl';
    const text = '#pragma multi_compile _ FOO_ON';
    registerVariantKeywordsHandler(connection, documentsWith(uri, 'hlsl', 1, text));
    const handler = getHandler();
    const result = handler({ textDocument: { uri } });
    expect(result.keywords).toEqual(['FOO_ON']);
  });

  it('returns empty array when document is not found', () => {
    const { connection, getHandler } = fakeConnection();
    registerVariantKeywordsHandler(connection, documentsWith('file:///t/other.hlsl', 'hlsl', 1, 'int x;'));
    const handler = getHandler();
    const result = handler({ textDocument: { uri: 'file:///t/missing.hlsl' } });
    expect(result.keywords).toEqual([]);
  });
});
