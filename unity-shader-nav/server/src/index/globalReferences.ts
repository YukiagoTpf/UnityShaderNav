import type { FileIndex, ReferenceEntry } from '@unity-shader-nav/shared';

export class GlobalReferenceIndex {
  private readonly byName = new Map<string, ReferenceEntry[]>();
  private readonly byUri = new Map<string, ReferenceEntry[]>();

  upsert(file: FileIndex): void {
    this.delete(file.uri);

    for (const reference of file.references) {
      const entries = this.byName.get(reference.name) ?? [];
      entries.push(reference);
      this.byName.set(reference.name, entries);
    }

    this.byUri.set(file.uri, file.references.slice());
  }

  delete(uri: string): void {
    const previous = this.byUri.get(uri);
    if (!previous) return;

    for (const reference of previous) {
      const entries = this.byName.get(reference.name);
      if (!entries) continue;

      const next = entries.filter((entry) => entry.location.uri !== uri);
      if (next.length === 0) this.byName.delete(reference.name);
      else this.byName.set(reference.name, next);
    }

    this.byUri.delete(uri);
  }

  clear(): void {
    this.byName.clear();
    this.byUri.clear();
  }

  lookup(name: string): ReferenceEntry[] {
    return this.byName.get(name)?.slice() ?? [];
  }
}
