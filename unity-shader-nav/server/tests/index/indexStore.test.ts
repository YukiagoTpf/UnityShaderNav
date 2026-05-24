import { describe, expect, it } from 'vitest';
import type { FileIndex } from '@unity-shader-nav/shared';
import { IndexStore } from '../../src/index/indexStore';

function idx(uri: string): FileIndex {
  return { uri, symbols: [], references: [] };
}

describe('IndexStore', () => {
  it('stores, retrieves, lists, and deletes file indexes by uri', () => {
    const store = new IndexStore();
    const first = idx('file:///one.hlsl');
    const second = idx('file:///two.hlsl');

    store.set(first.uri, first);
    store.set(second.uri, second);

    expect(store.get(first.uri)).toBe(first);
    expect([...store.uris()]).toEqual([first.uri, second.uri]);

    store.delete(first.uri);

    expect(store.get(first.uri)).toBeUndefined();
    expect([...store.uris()]).toEqual([second.uri]);

    store.clear();

    expect(store.get(second.uri)).toBeUndefined();
    expect([...store.uris()]).toEqual([]);
  });

  it('treats encoded and plain Windows drive file URIs as the same file', () => {
    const store = new IndexStore();
    const file = idx('file:///f:/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader');

    store.set(file.uri, file);

    expect(store.get('file:///f%3A/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader')).toBe(file);

    store.delete('file:///f%3A/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader');

    expect(store.get(file.uri)).toBeUndefined();
  });
});
