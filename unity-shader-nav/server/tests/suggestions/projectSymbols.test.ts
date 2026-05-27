import { describe, expect, it } from 'vitest';
import type { FileIndex, FunctionSymbolEntry, SymbolEntry } from '@unity-shader-nav/shared';
import { IndexStore } from '../../src/index';
import { collectVisibleProjectSuggestions } from '../../src/suggestions';
import { uriKey } from '../../src/index/uriKey';

const mainUri = 'file:///t/main.hlsl';
const includeUri = 'file:///t/include.hlsl';
const otherUri = 'file:///t/other.hlsl';
const scopeRange = { start: { line: 1, character: 0 }, end: { line: 5, character: 0 } };

function symbol(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return {
    location: {
      uri: mainUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
    ...overrides,
  };
}

function fn(name: string, uri: string, line: number, parameters: Array<{ type: string; name: string }> = []): FunctionSymbolEntry {
  return {
    name,
    kind: 'function',
    returnType: 'float4',
    parameters: parameters.map((parameter, index) => ({
      ...parameter,
      range: { start: { line, character: index }, end: { line, character: index + 1 } },
    })),
    location: {
      uri,
      range: { start: { line, character: 7 }, end: { line, character: 7 + name.length } },
    },
  };
}

function storeOf(indexes: FileIndex[]): IndexStore {
  const store = new IndexStore();
  for (const index of indexes) store.set(index.uri, index);
  return store;
}

describe('collectVisibleProjectSuggestions', () => {
  it('returns scoped locals, same-file globals, and include-visible globals in rank order', () => {
    const main: FileIndex = {
      uri: mainUri,
      references: [],
      symbols: [
        fn('SameFile', mainUri, 0),
        symbol({
          name: 'localValue',
          kind: 'localVariable',
          declaredType: 'float',
          scopeRange,
          location: { uri: mainUri, range: { start: { line: 2, character: 8 }, end: { line: 2, character: 18 } } },
        }),
      ],
    };
    const include: FileIndex = { uri: includeUri, references: [], symbols: [fn('Included', includeUri, 0)] };
    const other: FileIndex = { uri: otherUri, references: [], symbols: [fn('Hidden', otherUri, 0)] };

    const suggestions = collectVisibleProjectSuggestions({
      index: main,
      store: storeOf([main, include, other]),
      visibleUriKeys: new Set([uriKey(mainUri), uriKey(includeUri)]),
      position: { line: 3, character: 2 },
    });

    expect(suggestions.map((item) => item.name)).toEqual(['localValue', 'SameFile', 'Included']);
    expect(suggestions.map((item) => item.sortText)).toEqual(['0_localValue', '1_SameFile', '2_Included']);
  });

  it('requires locals and parameters to be in scope and declared before the cursor', () => {
    const index: FileIndex = {
      uri: mainUri,
      references: [],
      symbols: [
        symbol({
          name: 'futureLocal',
          kind: 'localVariable',
          scopeRange,
          location: { uri: mainUri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 13 } } },
        }),
        symbol({
          name: 'param',
          kind: 'parameter',
          scopeRange,
          location: { uri: mainUri, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 17 } } },
        }),
      ],
    };

    const suggestions = collectVisibleProjectSuggestions({
      index,
      store: storeOf([index]),
      visibleUriKeys: new Set([uriKey(mainUri)]),
      position: { line: 3, character: 0 },
    });

    expect(suggestions.map((item) => item.name)).toEqual(['param']);
  });

  it('keeps the nearest scoped symbol for same-name shadowing', () => {
    const index: FileIndex = {
      uri: mainUri,
      references: [],
      symbols: [
        symbol({
          name: 'value',
          kind: 'parameter',
          declaredType: 'float',
          scopeRange,
          location: { uri: mainUri, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 17 } } },
        }),
        symbol({
          name: 'value',
          kind: 'localVariable',
          declaredType: 'float2',
          scopeRange,
          location: { uri: mainUri, range: { start: { line: 2, character: 8 }, end: { line: 2, character: 13 } } },
        }),
        symbol({
          name: 'value',
          kind: 'localVariable',
          declaredType: 'float3',
          scopeRange,
          location: { uri: mainUri, range: { start: { line: 3, character: 8 }, end: { line: 3, character: 13 } } },
        }),
      ],
    };

    const suggestions = collectVisibleProjectSuggestions({
      index,
      store: storeOf([index]),
      visibleUriKeys: new Set([uriKey(mainUri)]),
      position: { line: 4, character: 0 },
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      name: 'value',
      kind: 'localVariable',
      declaredType: 'float3',
    });
  });

  it('dedupes display groups while preserving function overload-like candidates', () => {
    const index: FileIndex = {
      uri: mainUri,
      references: [],
      symbols: [
        symbol({ name: '_Color', kind: 'variable', declaredType: 'float4' }),
        symbol({ name: '_Color', kind: 'variable', declaredType: 'half4' }),
        fn('Lighting', mainUri, 1, [{ type: 'float3', name: 'normalWS' }]),
        fn('Lighting', mainUri, 2, [{ type: 'half3', name: 'normalWS' }]),
      ],
    };

    const suggestions = collectVisibleProjectSuggestions({
      index,
      store: storeOf([index]),
      visibleUriKeys: new Set([uriKey(mainUri)]),
      position: { line: 10, character: 0 },
    });

    expect(suggestions.filter((item) => item.name === '_Color')).toHaveLength(1);
    expect(suggestions.filter((item) => item.name === 'Lighting')).toHaveLength(2);
  });
});
