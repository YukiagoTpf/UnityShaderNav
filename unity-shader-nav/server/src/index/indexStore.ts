import type { FileIndex } from '@unity-shader-nav/shared';

export class IndexStore {
  private readonly byUri = new Map<string, FileIndex>();

  set(uri: string, idx: FileIndex): void {
    this.byUri.set(uri, idx);
  }

  get(uri: string): FileIndex | undefined {
    return this.byUri.get(uri);
  }

  delete(uri: string): void {
    this.byUri.delete(uri);
  }

  uris(): IterableIterator<string> {
    return this.byUri.keys();
  }
}
