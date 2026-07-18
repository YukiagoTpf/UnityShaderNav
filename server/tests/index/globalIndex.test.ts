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

  it('replaces entries when Windows drive file URIs differ only by encoding', () => {
    const global = new GlobalSymbolIndex();

    global.upsert(fileIndex('file:///f:/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader', ['old']));
    global.upsert(fileIndex('file:///f%3A/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader', ['new']));

    expect(global.lookup('old')).toEqual([]);
    expect(global.lookup('new')).toHaveLength(1);
  });

  it('clears all indexed symbols', () => {
    const global = new GlobalSymbolIndex();

    global.upsert(fileIndex('file:///a.hlsl', ['foo']));
    global.upsert(fileIndex('file:///b.hlsl', ['bar']));
    global.clear();

    expect(global.lookup('foo')).toEqual([]);
    expect(global.lookup('bar')).toEqual([]);
    expect([...global.uris()]).toEqual([]);
  });

  it('shares immutable file shards across forks and preserves update ordering', () => {
    const global = new GlobalSymbolIndex();
    global.upsert(fileIndex('file:///a.hlsl', ['shared', 'a']));
    global.upsert(fileIndex('file:///b.hlsl', ['shared', 'b']));

    const fork = global.fork();
    fork.upsert(fileIndex('file:///a.hlsl', ['shared', 'updated']));

    expect(global.lookup('shared').map((entry) => entry.location.uri)).toEqual([
      'file:///a.hlsl',
      'file:///b.hlsl',
    ]);
    expect(fork.lookup('shared').map((entry) => entry.location.uri)).toEqual([
      'file:///b.hlsl',
      'file:///a.hlsl',
    ]);
    expect(global.lookup('a')).toHaveLength(1);
    expect(global.lookup('updated')).toEqual([]);
    expect(fork.lookup('a')).toEqual([]);
    expect(fork.lookup('updated')).toHaveLength(1);
  });
});
