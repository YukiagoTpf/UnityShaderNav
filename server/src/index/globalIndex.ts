import type { FileIndex, SymbolEntry } from '@unity-shader-nav/shared';
import { FileShardIndex } from './fileShardIndex';

export interface GlobalSymbolReader {
  lookup(name: string): SymbolEntry[];
  entries(): IterableIterator<SymbolEntry>;
}

export class GlobalSymbolIndex implements GlobalSymbolReader {
  constructor(
    private readonly shards = FileShardIndex.empty<SymbolEntry>(),
  ) {}

  fork(): GlobalSymbolIndex {
    return new GlobalSymbolIndex(this.shards.fork());
  }

  upsert(file: FileIndex): void {
    this.shards.upsert(file.uri, file.symbols);
  }

  delete(uri: string): void {
    this.shards.delete(uri);
  }

  clear(): void {
    this.shards.clear();
  }

  lookup(name: string): SymbolEntry[] {
    return this.shards.lookup(name);
  }

  uris(): IterableIterator<string> {
    return this.shards.uris();
  }

  entries(): IterableIterator<SymbolEntry> {
    return this.shards.entries();
  }
}
