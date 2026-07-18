import type { FileIndex, ReferenceEntry } from '@unity-shader-nav/shared';
import { FileShardIndex } from './fileShardIndex';

export interface GlobalReferenceReader {
  lookup(name: string): ReferenceEntry[];
}

export class GlobalReferenceIndex implements GlobalReferenceReader {
  constructor(
    private readonly shards = FileShardIndex.empty<ReferenceEntry>(),
  ) {}

  fork(): GlobalReferenceIndex {
    return new GlobalReferenceIndex(this.shards.fork());
  }

  upsert(file: FileIndex): void {
    this.shards.upsert(file.uri, file.references);
  }

  delete(uri: string): void {
    this.shards.delete(uri);
  }

  clear(): void {
    this.shards.clear();
  }

  lookup(name: string): ReferenceEntry[] {
    return this.shards.lookup(name);
  }
}
