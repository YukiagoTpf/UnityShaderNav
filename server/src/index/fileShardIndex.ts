import { uriKey } from '../uriKey';
import {
  PersistentOrderedMap,
  PersistentStringMap,
} from './persistentStringMap';

interface NamedEntry {
  readonly name: string;
}

interface FileShard<T> {
  readonly uri: string;
  readonly entries: readonly T[];
}

/**
 * Per-file immutable shards with persistent roots. A fork shares every shard;
 * replacing one file path-copies only the affected URI and name paths.
 */
export class FileShardIndex<T extends NamedEntry> {
  private constructor(
    private byUri: PersistentOrderedMap<FileShard<T>>,
    private byName: PersistentStringMap<PersistentOrderedMap<readonly T[]>>,
  ) {}

  static empty<T extends NamedEntry>(): FileShardIndex<T> {
    return new FileShardIndex(
      PersistentOrderedMap.empty(),
      PersistentStringMap.empty(),
    );
  }

  fork(): FileShardIndex<T> {
    return new FileShardIndex(this.byUri, this.byName);
  }

  upsert(uri: string, entries: readonly T[]): void {
    const key = uriKey(uri);
    const previous = this.byUri.get(key);
    if (previous) this.removeNamedShards(key, previous.entries);

    const immutableEntries = Object.freeze([...entries]);
    this.byUri = this.byUri.delete(key).set(
      key,
      Object.freeze({ uri, entries: immutableEntries }),
    );

    const groups = new Map<string, T[]>();
    for (const entry of immutableEntries) {
      const named = groups.get(entry.name) ?? [];
      named.push(entry);
      groups.set(entry.name, named);
    }
    for (const [name, named] of groups) {
      const files = this.byName.get(name) ?? PersistentOrderedMap.empty<readonly T[]>();
      this.byName = this.byName.set(
        name,
        files.delete(key).set(key, Object.freeze(named)),
      );
    }
  }

  delete(uri: string): void {
    const key = uriKey(uri);
    const previous = this.byUri.get(key);
    if (!previous) return;
    this.removeNamedShards(key, previous.entries);
    this.byUri = this.byUri.delete(key);
  }

  clear(): void {
    this.byUri = PersistentOrderedMap.empty();
    this.byName = PersistentStringMap.empty();
  }

  lookup(name: string): T[] {
    const files = this.byName.get(name);
    if (!files) return [];
    const result: T[] = [];
    for (const entries of files.values()) result.push(...entries);
    return result;
  }

  *uris(): IterableIterator<string> {
    for (const shard of this.byUri.values()) yield shard.uri;
  }

  *entries(): IterableIterator<T> {
    for (const shard of this.byUri.values()) {
      for (const entry of shard.entries) yield entry;
    }
  }

  private removeNamedShards(key: string, entries: readonly T[]): void {
    for (const name of new Set(entries.map((entry) => entry.name))) {
      const files = this.byName.get(name);
      if (!files) continue;
      const remaining = files.delete(key);
      this.byName = remaining.size === 0
        ? this.byName.delete(name)
        : this.byName.set(name, remaining);
    }
  }
}
