import { describe, expect, it } from 'vitest';
import type { FileIndex, SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { collectMemberSuggestions } from '../../src/suggestions';
import { uriKey } from '../../src/index/uriKey';

const uri = 'file:///t/main.hlsl';
const typesUri = 'file:///t/types.hlsl';
const functionScope = { start: { line: 5, character: 0 }, end: { line: 30, character: 0 } };

function sym(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return {
    location: {
      uri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
    ...overrides,
  };
}

function fixture() {
  const index: FileIndex = {
    uri,
    references: [],
    symbols: [
      sym({ name: 'surface', kind: 'parameter', declaredType: 'Surface', scopeRange: functionScope }),
      sym({ name: 'lights', kind: 'parameter', declaredType: 'Light', scopeRange: functionScope }),
    ],
  };
  const types: FileIndex = {
    uri: typesUri,
    references: [],
    symbols: [
      sym({ name: 'positionWS', kind: 'structMember', parentType: 'Surface', declaredType: 'float3', location: { uri: typesUri, range: { start: { line: 1, character: 9 }, end: { line: 1, character: 19 } } } }),
      sym({ name: 'brdfData', kind: 'structMember', parentType: 'Surface', declaredType: 'Brdf', location: { uri: typesUri, range: { start: { line: 2, character: 7 }, end: { line: 2, character: 15 } } } }),
      sym({ name: 'roughness', kind: 'structMember', parentType: 'Brdf', declaredType: 'float', location: { uri: typesUri, range: { start: { line: 5, character: 8 }, end: { line: 5, character: 17 } } } }),
      sym({ name: 'color', kind: 'structMember', parentType: 'Light', declaredType: 'float3', location: { uri: typesUri, range: { start: { line: 9, character: 9 }, end: { line: 9, character: 14 } } } }),
    ],
  };
  const store = new IndexStore();
  const global = new GlobalSymbolIndex();
  for (const file of [index, types]) {
    store.set(file.uri, file);
    global.upsert(file);
  }
  const visible = new Set([uriKey(uri), uriKey(typesUri)]);
  return { index, store, global, visible };
}

describe('collectMemberSuggestions', () => {
  it('suggests and filters members for a receiver type', () => {
    const { index, store, global, visible } = fixture();

    expect(collectMemberSuggestions(index, store, global, visible, 'surface', '', { line: 10, character: 0 })
      .map((item) => item.name)).toEqual(['positionWS', 'brdfData']);
    expect(collectMemberSuggestions(index, store, global, visible, 'surface', 'pos', { line: 10, character: 0 })
      .map((item) => item.name)).toEqual(['positionWS']);
  });

  it('supports array and nested receiver shapes', () => {
    const { index, store, global, visible } = fixture();

    expect(collectMemberSuggestions(index, store, global, visible, 'lights[i]', '', { line: 10, character: 0 })
      .map((item) => item.name)).toEqual(['color']);
    expect(collectMemberSuggestions(index, store, global, visible, 'surface.brdfData', '', { line: 10, character: 0 })
      .map((item) => item.name)).toEqual(['roughness']);
  });

  it('returns an empty list for unknown receivers', () => {
    const { index, store, global, visible } = fixture();

    expect(collectMemberSuggestions(index, store, global, visible, 'missing', '', { line: 10, character: 0 }))
      .toEqual([]);
  });
});
