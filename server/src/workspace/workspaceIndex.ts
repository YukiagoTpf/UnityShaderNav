import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type { FileIndex, UserDeclarationMacro } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../index';
import { uriKey } from '../uriKey';
import { MacroPatternTable } from '../macros';
import { indexFile } from '../parser/hlsl';

export interface FileEvent {
  uri: string;
  type: 'created' | 'changed' | 'deleted';
}

export type DocumentIndexer = (
  uri: string,
  text: string,
  table: MacroPatternTable,
) => Promise<FileIndex>;

export interface PreparedDocumentIndex {
  readonly uri: string;
  readonly liveIndex: FileIndex;
  /** undefined: keep Unity scan state; null: standalone file has no disk form. */
  readonly diskIndex: FileIndex | null | undefined;
}

/**
 * Owns the live + on-disk index state composed by Workspace:
 * store / global / globalRefs / diskIndexes / declaration-macro table, plus all
 * index-mutation operations. Callers reach it via workspace.index; the
 * lifecycle + cache concern stays in Workspace, which keeps only applyChanges
 * (it orchestrates index.applyChanges + persist).
 */
export class WorkspaceIndex {
  readonly store = new IndexStore();
  readonly global = new GlobalSymbolIndex();
  readonly globalRefs = new GlobalReferenceIndex();
  private readonly diskIndexes = new Map<string, FileIndex>();
  private _table: MacroPatternTable;
  private readonly isStandalone: () => boolean;
  private readonly indexDocument: DocumentIndexer;

  constructor(
    table: MacroPatternTable,
    isStandalone: () => boolean,
    indexDocument: DocumentIndexer = indexFile,
  ) {
    this._table = table;
    this.isStandalone = isStandalone;
    this.indexDocument = indexDocument;
  }

  get table(): MacroPatternTable {
    return this._table;
  }

  /**
   * Recompile the declaration-macro table from settings' declarationMacros.
   * The settings -> table invariant is owned by Workspace.applySettings, which
   * is this method's only caller.
   */
  rebuildTable(declarationMacros: UserDeclarationMacro[]): void {
    this._table = new MacroPatternTable(declarationMacros);
  }

  /**
   * Invariant 1 (cache restore order): diskIndexes -> store -> global -> globalRefs.
   * Used by Workspace.bootstrapFromCache; mirrors indexAndStore's ordering.
   */
  restoreFromCache(uri: string, index: FileIndex): void {
    this.diskIndexes.set(uriKey(uri), index);
    this.store.set(uri, index);
    this.global.upsert(index);
    this.globalRefs.upsert(index);
  }

  /** Invariant 4: persist() snapshots diskIndexes, never store. Open documents are excluded. */
  diskIndexEntries(): Array<[string, FileIndex]> {
    return Array.from(
      this.diskIndexes.values(),
      (index): [string, FileIndex] => [index.uri, index],
    );
  }

  hasDiskIndex(uri: string): boolean {
    return this.diskIndexes.has(uriKey(uri));
  }

  /** Invariant 3: rebuild() clears all three indexes + diskIndexes before re-bootstrapping. */
  clear(): void {
    this.store.clear();
    this.global.clear();
    this.globalRefs.clear();
    this.diskIndexes.clear();
  }

  async indexAndStore(
    absPath: string,
    connection?: Connection,
    shouldStore: () => boolean = () => true,
  ): Promise<boolean> {
    const uri = pathToFileURL(absPath).href;
    let text: string;
    try {
      text = await fs.readFile(absPath, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (typeof connection?.console.warn === 'function') {
        connection.console.warn(`[index] skipped unreadable source ${uri}: ${detail}`);
      }
      return false;
    }

    // Parser/index exceptions are infrastructure failures. They must abort the
    // current operation instead of being mistaken for a valid empty project.
    const idx = await this.indexDocument(uri, text, this.table);
    if (!shouldStore()) return false;
    // Invariant 1 order: diskIndexes -> store -> global -> globalRefs.
    this.diskIndexes.set(uriKey(uri), idx);
    this.store.set(uri, idx);
    this.global.upsert(idx);
    this.globalRefs.upsert(idx);
    connection?.console.log(`[index] ${uri} -> ${idx.symbols.length} symbols, ${idx.references.length} refs`);
    return true;
  }

  /**
   * Prepare a live document without mutating serving state. The final validity
   * check and the commit are adjacent and synchronous, so a close/newer edit
   * cannot publish stale text after standalone disk I/O completes.
   */
  async prepareDocument(
    uri: string,
    text: string,
    shouldContinue: () => boolean = () => true,
  ): Promise<PreparedDocumentIndex | undefined> {
    const liveIndex = await this.indexDocument(uri, text, this.table);
    if (!shouldContinue()) return undefined;

    let diskIndex: FileIndex | null | undefined;
    if (this.isStandalone()) {
      diskIndex = await this.readStandaloneDiskIndex(uri, text, liveIndex);
      if (!shouldContinue()) return undefined;
    }
    return { uri, liveIndex, diskIndex };
  }

  commitDocument(
    candidate: PreparedDocumentIndex,
    shouldStore: () => boolean = () => true,
  ): boolean {
    if (!shouldStore()) return false;
    if (candidate.diskIndex === null) {
      this.diskIndexes.delete(uriKey(candidate.uri));
    } else if (candidate.diskIndex !== undefined) {
      this.diskIndexes.set(uriKey(candidate.uri), candidate.diskIndex);
    }
    this.store.set(candidate.uri, candidate.liveIndex);
    this.global.upsert(candidate.liveIndex);
    this.globalRefs.upsert(candidate.liveIndex);
    return true;
  }

  async reindex(
    uri: string,
    text: string,
    shouldStore: () => boolean = () => true,
  ): Promise<boolean> {
    const candidate = await this.prepareDocument(uri, text, shouldStore);
    return candidate ? this.commitDocument(candidate, shouldStore) : false;
  }

  private async readStandaloneDiskIndex(
    uri: string,
    liveText: string,
    liveIndex: FileIndex,
  ): Promise<FileIndex | null> {
    let diskText: string;
    try {
      diskText = await fs.readFile(fileURLToPath(uri), 'utf8');
    } catch {
      return null;
    }
    return diskText === liveText
      ? liveIndex
      : this.indexDocument(uri, diskText, this.table);
  }

  /**
   * Apply file-watcher events to the indexes. Index-mutation only — the kept
   * Workspace.applyChanges calls persist() afterward.
   */
  async applyChanges(
    events: FileEvent[],
    connection: Connection,
    shouldStore: () => boolean = () => true,
  ): Promise<void> {
    for (const event of events) {
      if (!shouldStore()) return;
      if (event.type === 'deleted') {
        this.drop(event.uri);
        continue;
      }

      const filePath = fileURLToPath(event.uri);
      await this.indexAndStore(filePath, connection, shouldStore);
    }
  }

  /**
   * Restore the last valid disk index. If a document opened before any scan,
   * read its disk form now; an absent file removes the live-only entry.
   */
  async restoreClosedDocument(
    uri: string,
    shouldStore: () => boolean = () => true,
  ): Promise<boolean> {
    const diskIndex = this.diskIndexes.get(uriKey(uri));
    if (diskIndex) {
      if (!shouldStore()) return false;
      this.store.set(uri, diskIndex);
      this.global.upsert(diskIndex);
      this.globalRefs.upsert(diskIndex);
      return true;
    }

    let diskText: string;
    try {
      diskText = await fs.readFile(fileURLToPath(uri), 'utf8');
    } catch {
      if (!shouldStore()) return false;
      this.drop(uri);
      return true;
    }
    if (!shouldStore()) return false;
    const restored = await this.indexDocument(uri, diskText, this.table);
    if (!shouldStore()) return false;
    this.diskIndexes.set(uriKey(uri), restored);
    this.store.set(uri, restored);
    this.global.upsert(restored);
    this.globalRefs.upsert(restored);
    return true;
  }

  /** Backward-compatible low-level helper; production document flow uses Workspace. */
  closeDocument(uri: string): void {
    const diskIndex = this.diskIndexes.get(uriKey(uri));
    if (diskIndex) {
      this.store.set(uri, diskIndex);
      this.global.upsert(diskIndex);
      this.globalRefs.upsert(diskIndex);
    } else {
      this.drop(uri);
    }
  }

  drop(uri: string): void {
    this.diskIndexes.delete(uriKey(uri));
    this.store.delete(uri);
    this.global.delete(uri);
    this.globalRefs.delete(uri);
  }
}
