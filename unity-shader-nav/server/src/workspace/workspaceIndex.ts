import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../index';
import { MacroPatternTable } from '../macros';
import { indexFile } from '../parser/hlsl';

export interface FileEvent {
  uri: string;
  type: 'created' | 'changed' | 'deleted';
}

/**
 * Owns the live + on-disk index state extracted from Workspace (#31):
 * store / global / globalRefs / diskIndexes / declaration-macro table, plus all
 * index-mutation operations. Workspace composes one and exposes pass-throughs;
 * the lifecycle + cache concern stays in Workspace.
 */
export class WorkspaceIndex {
  readonly store = new IndexStore();
  readonly global = new GlobalSymbolIndex();
  readonly globalRefs = new GlobalReferenceIndex();
  private readonly diskIndexes = new Map<string, FileIndex>();
  table: MacroPatternTable;

  constructor(table: MacroPatternTable) {
    this.table = table;
  }

  /**
   * Invariant 1 (cache restore order): diskIndexes -> store -> global -> globalRefs.
   * Used by Workspace.bootstrapFromCache; mirrors indexAndStore's ordering.
   */
  restoreFromCache(uri: string, index: FileIndex): void {
    this.diskIndexes.set(uri, index);
    this.store.set(uri, index);
    this.global.upsert(index);
    this.globalRefs.upsert(index);
  }

  /** Invariant 4: persist() snapshots diskIndexes, never store. Open documents are excluded. */
  diskIndexEntries(): Array<[string, FileIndex]> {
    return Array.from(this.diskIndexes);
  }

  /** Invariant 3: rebuild() clears all three indexes + diskIndexes before re-bootstrapping. */
  clear(): void {
    this.store.clear();
    this.global.clear();
    this.globalRefs.clear();
    this.diskIndexes.clear();
  }

  async indexAndStore(absPath: string, connection?: Connection): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    try {
      const text = await fs.readFile(absPath, 'utf8');
      const idx = await indexFile(uri, text, this.table);
      // Invariant 1 order: diskIndexes -> store -> global -> globalRefs.
      this.diskIndexes.set(uri, idx);
      this.store.set(uri, idx);
      this.global.upsert(idx);
      this.globalRefs.upsert(idx);
      connection?.console.log(`[index] ${uri} -> ${idx.symbols.length} symbols, ${idx.references.length} refs`);
    } catch {
      // Ignore unreadable or unparsable files during background indexing.
    }
  }

  async reindex(
    uri: string,
    text: string,
    isStandalone: boolean,
    shouldStore: () => boolean = () => true,
  ): Promise<void> {
    const idx = await indexFile(uri, text, this.table);
    if (!shouldStore()) return;
    if (isStandalone) {
      await this.refreshStandaloneDiskIndex(uri, text, idx);
    }
    this.store.set(uri, idx);
    this.global.upsert(idx);
    this.globalRefs.upsert(idx);
  }

  private async refreshStandaloneDiskIndex(
    uri: string,
    liveText: string,
    liveIndex: FileIndex,
  ): Promise<void> {
    try {
      const diskText = await fs.readFile(fileURLToPath(uri), 'utf8');
      const diskIndex = diskText === liveText
        ? liveIndex
        : await indexFile(uri, diskText, this.table);
      this.diskIndexes.set(uri, diskIndex);
    } catch {
      this.diskIndexes.delete(uri);
    }
  }

  /**
   * Apply file-watcher events to the indexes. Index-mutation only — Workspace's
   * applyChanges pass-through calls persist() afterward.
   */
  async applyChanges(events: FileEvent[], connection: Connection): Promise<void> {
    for (const event of events) {
      if (event.type === 'deleted') {
        this.drop(event.uri);
        continue;
      }

      try {
        const filePath = fileURLToPath(event.uri);
        await this.indexAndStore(filePath, connection);
      } catch {
        this.drop(event.uri);
      }
    }
  }

  /** Invariant 2: fall back to the on-disk index if present; otherwise drop from all three. */
  closeDocument(uri: string): void {
    const diskIndex = this.diskIndexes.get(uri);
    if (diskIndex) {
      this.store.set(uri, diskIndex);
      this.global.upsert(diskIndex);
      this.globalRefs.upsert(diskIndex);
      return;
    }

    this.drop(uri);
  }

  drop(uri: string): void {
    this.diskIndexes.delete(uri);
    this.store.delete(uri);
    this.global.delete(uri);
    this.globalRefs.delete(uri);
  }
}
