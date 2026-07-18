import type { FileIndex } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import { PersistentOrderedMap } from './persistentStringMap';

export interface IndexStoreReader {
  get(uri: string): FileIndex | undefined;
  uris(): IterableIterator<string>;
}

export class IndexStore implements IndexStoreReader {
  constructor(
    private byUri = PersistentOrderedMap.empty<FileIndex>(),
  ) {}

  fork(): IndexStore {
    return new IndexStore(this.byUri);
  }

  set(uri: string, idx: FileIndex): void {
    this.byUri = this.byUri.set(uriKey(uri), idx);
  }

  get(uri: string): FileIndex | undefined {
    return this.byUri.get(uriKey(uri));
  }

  delete(uri: string): void {
    this.byUri = this.byUri.delete(uriKey(uri));
  }

  clear(): void {
    this.byUri = PersistentOrderedMap.empty();
  }

  *uris(): IterableIterator<string> {
    for (const index of this.byUri.values()) yield index.uri;
  }
}
