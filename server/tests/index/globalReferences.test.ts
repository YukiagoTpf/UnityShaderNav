import { describe, expect, it } from 'vitest';
import type { FileIndex, ReferenceEntry } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex } from '../../src/index/globalReferences';

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 3 },
};

function reference(uri: string, name: string): ReferenceEntry {
  return {
    name,
    context: 'call',
    location: { uri, range },
  };
}

function fileIndex(uri: string, references: ReferenceEntry[]): FileIndex {
  return { uri, symbols: [], references };
}

describe('GlobalReferenceIndex', () => {
  it('aggregates references across files', () => {
    const global = new GlobalReferenceIndex();

    global.upsert(fileIndex('file:///a.hlsl', [reference('file:///a.hlsl', 'foo')]));
    global.upsert(fileIndex('file:///b.hlsl', [reference('file:///b.hlsl', 'foo')]));

    expect(global.lookup('foo')).toHaveLength(2);
    expect(global.lookup('missing')).toEqual([]);
  });

  it('clears previous file entries on upsert', () => {
    const global = new GlobalReferenceIndex();

    global.upsert(fileIndex('file:///a.hlsl', [reference('file:///a.hlsl', 'x')]));
    global.upsert(fileIndex('file:///a.hlsl', []));

    expect(global.lookup('x')).toEqual([]);
  });

  it('removes everything for a uri on delete', () => {
    const global = new GlobalReferenceIndex();

    global.upsert(fileIndex('file:///a.hlsl', [reference('file:///a.hlsl', 'foo')]));
    global.delete('file:///a.hlsl');

    expect(global.lookup('foo')).toEqual([]);
  });

  it('replaces entries when Windows drive file URIs differ only by encoding', () => {
    const global = new GlobalReferenceIndex();
    const plain = 'file:///f:/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader';
    const encoded = 'file:///f%3A/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader';

    global.upsert(fileIndex(plain, [reference(plain, 'old')]));
    global.upsert(fileIndex(encoded, [reference(encoded, 'new')]));

    expect(global.lookup('old')).toEqual([]);
    expect(global.lookup('new')).toHaveLength(1);
  });

  it('clears all indexed references', () => {
    const global = new GlobalReferenceIndex();

    global.upsert(fileIndex('file:///a.hlsl', [reference('file:///a.hlsl', 'foo')]));
    global.upsert(fileIndex('file:///b.hlsl', [reference('file:///b.hlsl', 'bar')]));
    global.clear();

    expect(global.lookup('foo')).toEqual([]);
    expect(global.lookup('bar')).toEqual([]);
  });
});
