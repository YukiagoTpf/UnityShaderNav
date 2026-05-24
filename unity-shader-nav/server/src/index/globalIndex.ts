import type { FileIndex, SymbolEntry } from '@unity-shader-nav/shared';
import { uriKey } from './uriKey';

export class GlobalSymbolIndex {
  private readonly byName = new Map<string, SymbolEntry[]>();
  private readonly byUri = new Map<string, SymbolEntry[]>();

  upsert(file: FileIndex): void {
    this.delete(file.uri);
    const key = uriKey(file.uri);

    for (const symbol of file.symbols) {
      const entries = this.byName.get(symbol.name) ?? [];
      entries.push(symbol);
      this.byName.set(symbol.name, entries);
    }

    this.byUri.set(key, file.symbols.slice());
  }

  delete(uri: string): void {
    const key = uriKey(uri);
    const previous = this.byUri.get(key);
    if (!previous) return;

    for (const symbol of previous) {
      const entries = this.byName.get(symbol.name);
      if (!entries) continue;

      const next = entries.filter((entry) => uriKey(entry.location.uri) !== key);
      if (next.length === 0) this.byName.delete(symbol.name);
      else this.byName.set(symbol.name, next);
    }

    this.byUri.delete(key);
  }

  clear(): void {
    this.byName.clear();
    this.byUri.clear();
  }

  lookup(name: string): SymbolEntry[] {
    return this.byName.get(name)?.slice() ?? [];
  }

  uris(): IterableIterator<string> {
    return this.byUri.keys();
  }
}
