import type { FileIndex, Range, SymbolEntry } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { GlobalSymbolIndex } from '../../src/index/globalIndex';
import {
  selectNamedSymbolEntries,
  selectScopedSymbolEntries,
  selectSymbolEntryGroups,
} from '../../src/index/symbolSelection';

const uri = 'file:///project/Main.hlsl';
const scopeRange: Range = {
  start: { line: 0, character: 0 },
  end: { line: 20, character: 0 },
};

function symbol(
  name: string,
  kind: SymbolEntry['kind'],
  line: number,
  extras: Partial<SymbolEntry> = {},
): SymbolEntry {
  return {
    name,
    kind,
    location: {
      uri,
      range: {
        start: { line, character: 2 },
        end: { line, character: 2 + name.length },
      },
    },
    ...extras,
  };
}

describe('symbol selection', () => {
  it('selects one nearest in-scope declaration across parameters and locals', () => {
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        symbol('value', 'variable', 0, { declaredType: 'float4' }),
        symbol('value', 'parameter', 1, { scopeRange, declaredType: 'half' }),
        symbol('value', 'localVariable', 3, { scopeRange, declaredType: 'float2' }),
        symbol('value', 'localVariable', 7, { scopeRange, declaredType: 'float3' }),
        symbol('value', 'localVariable', 12, { scopeRange, declaredType: 'future' }),
        symbol('value', 'localVariable', 4, {
          scopeRange: {
            start: { line: 0, character: 0 },
            end: { line: 5, character: 0 },
          },
          declaredType: 'expired',
        }),
      ],
    };

    expect(selectNamedSymbolEntries(index, 'value', { line: 10, character: 0 }))
      .toEqual([index.symbols[3]]);
    expect(selectNamedSymbolEntries(index, 'value', { line: 2, character: 0 }))
      .toEqual([index.symbols[1]]);
    expect(selectScopedSymbolEntries(index, { line: 10, character: 0 }))
      .toEqual([index.symbols[3]]);
  });

  it('preserves current-file and Include-visible global multi-candidates', () => {
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        symbol('Lighting', 'function', 1),
        symbol('Lighting', 'function', 2),
      ],
    };
    const visibleUri = 'file:///project/Visible.hlsl';
    const hiddenUri = 'file:///project/Hidden.hlsl';
    const global = new GlobalSymbolIndex();
    global.upsert(index);
    global.upsert({
      uri: visibleUri,
      references: [],
      symbols: [{
        ...symbol('Lighting', 'function', 3),
        location: {
          uri: visibleUri,
          range: symbol('Lighting', 'function', 3).location.range,
        },
      }],
    });
    global.upsert({
      uri: hiddenUri,
      references: [],
      symbols: [{
        ...symbol('Lighting', 'function', 4),
        location: {
          uri: hiddenUri,
          range: symbol('Lighting', 'function', 4).location.range,
        },
      }],
    });

    const selected = selectNamedSymbolEntries(
      index,
      'Lighting',
      { line: 10, character: 0 },
      global,
      { visibleUriKeys: new Set([uri, visibleUri]) },
    );

    expect(selected.map((entry) => entry.location.uri)).toEqual([
      uri,
      uri,
      visibleUri,
    ]);
  });

  it('batch-selects nearest scoped and all global namespaces in one pass', () => {
    const index: FileIndex = {
      uri,
      references: [],
      symbols: [
        symbol('SharedName', 'parameter', 1, { scopeRange }),
        symbol('SharedName', 'localVariable', 4, { scopeRange }),
        symbol('SharedName', 'function', 2),
      ],
    };
    const visibleUri = 'file:///project/Visible.hlsl';
    const hiddenUri = 'file:///project/Hidden.hlsl';
    const otherCandidates = [
      {
        ...symbol('SharedName', 'struct', 3),
        location: { uri: visibleUri, range: symbol('SharedName', 'struct', 3).location.range },
      },
      {
        ...symbol('SharedName', 'type', 5),
        location: { uri: hiddenUri, range: symbol('SharedName', 'type', 5).location.range },
      },
    ];

    const groups = selectSymbolEntryGroups(
      index,
      { line: 10, character: 0 },
      otherCandidates,
      { visibleUriKeys: new Set([uri, visibleUri]) },
    );

    expect(groups.scoped).toEqual([index.symbols[1]]);
    expect(groups.currentGlobals).toEqual([index.symbols[2]]);
    expect(groups.visibleGlobals).toEqual([otherCandidates[0]]);
  });
});
