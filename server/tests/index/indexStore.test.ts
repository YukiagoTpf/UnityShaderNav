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
    expect([...store.uris()]).toEqual([file.uri]);

    store.delete('file:///f%3A/Project/UnityProject/Pandora/Assets/Shader/Char_Common.shader');

    expect(store.get(file.uri)).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')('uses one bucket for macOS case and Unicode variants', () => {
    const store = new IndexStore();
    const file = idx('file:///project/Caf%C3%A9/Main.shader');

    store.set(file.uri, file);

    expect(store.get('file:///PROJECT/CAFE%CC%81/main.shader')).toBe(file);
    expect([...store.uris()]).toEqual([file.uri]);
  });

  it('forks in constant state and isolates later per-file replacements', () => {
    const store = new IndexStore();
    const first = idx('file:///first.hlsl');
    const second = idx('file:///second.hlsl');
    store.set(first.uri, first);
    store.set(second.uri, second);

    const fork = store.fork();
    const replacement = idx(first.uri);
    fork.set(first.uri, replacement);
    fork.delete(second.uri);

    expect(store.get(first.uri)).toBe(first);
    expect(store.get(second.uri)).toBe(second);
    expect(fork.get(first.uri)).toBe(replacement);
    expect(fork.get(second.uri)).toBeUndefined();
    expect([...store.uris()]).toEqual([first.uri, second.uri]);
    expect([...fork.uris()]).toEqual([first.uri]);
  });
});
