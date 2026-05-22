import { describe, expect, it } from 'vitest';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex } from '../../src/index/globalIndex';

function fileIndex(uri: string, names: string[]): FileIndex {
  return {
    uri,
    references: [],
    symbols: names.map((name) => ({
      name,
      kind: 'function',
      location: {
        uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
    })),
  };
}

describe('GlobalSymbolIndex', () => {
  it('aggregates symbols across files', () => {
    const global = new GlobalSymbolIndex();

    global.upsert(fileIndex('file:///a.hlsl', ['foo']));
    global.upsert(fileIndex('file:///b.hlsl', ['foo', 'bar']));

    expect(global.lookup('foo')).toHaveLength(2);
    expect(global.lookup('bar')).toHaveLength(1);
    expect(global.lookup('zzz')).toEqual([]);
  });

  it('removes per-file entries on upsert', () => {
    const global = new GlobalSymbolIndex();

    global.upsert(fileIndex('file:///a.hlsl', ['foo', 'bar']));
    global.upsert(fileIndex('file:///a.hlsl', ['foo']));

    expect(global.lookup('bar')).toEqual([]);
    expect(global.lookup('foo')).toHaveLength(1);
  });

  it('removes everything for a uri on delete()', () => {
    const global = new GlobalSymbolIndex();

    global.upsert(fileIndex('file:///a.hlsl', ['foo']));
    global.delete('file:///a.hlsl');

    expect(global.lookup('foo')).toEqual([]);
  });
});
