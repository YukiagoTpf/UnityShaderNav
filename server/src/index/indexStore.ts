import type { FileIndex } from '@unity-shader-nav/shared';
import { uriKey } from './uriKey';

export class IndexStore {
  private readonly byUri = new Map<string, FileIndex>();

  set(uri: string, idx: FileIndex): void {
    this.byUri.set(uriKey(uri), idx);
  }

  get(uri: string): FileIndex | undefined {
    return this.byUri.get(uriKey(uri));
  }

  delete(uri: string): void {
    this.byUri.delete(uriKey(uri));
  }

  clear(): void {
    this.byUri.clear();
  }

  uris(): IterableIterator<string> {
    return this.byUri.keys();
  }
}
