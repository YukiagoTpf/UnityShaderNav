import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type {
  FileIndex,
  ReferenceEntry,
  SymbolEntry,
  UserDeclarationMacro,
} from '@unity-shader-nav/shared';
import {
  analyzeDocument,
  type DocumentAnalysis,
  type DocumentAnalysisDemand,
} from '../analysis';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../index';
import { PersistentOrderedMap } from '../index/persistentStringMap';
import { uriKey } from '../uriKey';
import { MacroPatternRecognizer } from '../macros';
import { indexFile } from '../parser/hlsl';
import type { LiveDocumentTreeSession } from '../parser/hlsl/liveDocumentTreeSession';

export interface FileEvent {
  uri: string;
  type: 'created' | 'changed' | 'deleted';
}

export type DocumentIndexer = (
  uri: string,
  text: string,
  recognizer: MacroPatternRecognizer,
  analysis?: DocumentAnalysis,
  liveSession?: LiveDocumentTreeSession,
) => Promise<FileIndex>;

export type DocumentAnalyzer = (
  uri: string,
  text: string,
  demand: DocumentAnalysisDemand,
) => DocumentAnalysis | undefined;

export interface DiskSourceIdentity {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface DiskIndexRecord {
  readonly index: FileIndex;
  readonly source: DiskSourceIdentity;
}

export interface PreparedDocumentIndex {
  readonly uri: string;
  readonly liveIndex: FileIndex;
  readonly liveAnalysis: DocumentAnalysis | undefined;
  /** undefined: keep scan state; null: standalone file has no disk form. */
  readonly diskIndex: DiskIndexRecord | null | undefined;
}

export interface WorkspaceIndexReadView {
  readonly store: {
    get(uri: string): FileIndex | undefined;
    uris(): IterableIterator<string>;
  };
  readonly global: {
    lookup(name: string): SymbolEntry[];
    entries(): IterableIterator<SymbolEntry>;
  };
  readonly globalRefs: {
    lookup(name: string): ReferenceEntry[];
  };
}

export interface AppliedFileEvent {
  readonly uri: string;
  readonly type: FileEvent['type'];
  readonly indexed: boolean;
  readonly changed: boolean;
}

interface WorkspaceIndexForkState {
  readonly store: IndexStore;
  readonly global: GlobalSymbolIndex;
  readonly globalRefs: GlobalReferenceIndex;
  readonly diskIndexes: PersistentOrderedMap<DiskIndexRecord>;
}

/**
 * Private mutable index implementation used only while constructing a revision.
 * Published revisions retain an instance that is never mutated again; a later
 * transaction starts from {@link fork}, which shares immutable per-file shard
 * roots. Later writes path-copy only the changed URI/name paths.
 */
export class WorkspaceIndex {
  private readonly store: IndexStore;
  private readonly global: GlobalSymbolIndex;
  private readonly globalRefs: GlobalReferenceIndex;
  private diskIndexes: PersistentOrderedMap<DiskIndexRecord>;
  private readonly recognizer: MacroPatternRecognizer;
  private readonly standalone: boolean;
  private readonly indexDocument: DocumentIndexer;
  private readonly analyzeSource: DocumentAnalyzer;
  readonly read: WorkspaceIndexReadView;

  constructor(
    declarationMacros: readonly UserDeclarationMacro[] | MacroPatternRecognizer,
    standalone: boolean | (() => boolean),
    indexDocument: DocumentIndexer = indexFile,
    analyzeSource: DocumentAnalyzer = analyzeDocument,
    forkState?: WorkspaceIndexForkState,
  ) {
    this.recognizer = declarationMacros instanceof MacroPatternRecognizer
      ? declarationMacros
      : new MacroPatternRecognizer(declarationMacros);
    this.standalone = typeof standalone === 'function' ? standalone() : standalone;
    this.indexDocument = indexDocument;
    this.analyzeSource = analyzeSource;
    this.store = forkState?.store ?? new IndexStore();
    this.global = forkState?.global ?? new GlobalSymbolIndex();
    this.globalRefs = forkState?.globalRefs ?? new GlobalReferenceIndex();
    this.diskIndexes = forkState?.diskIndexes ?? PersistentOrderedMap.empty();
    this.read = Object.freeze({
      store: Object.freeze({
        get: (uri: string) => this.store.get(uri),
        uris: () => this.store.uris(),
      }),
      global: Object.freeze({
        lookup: (name: string) => this.global.lookup(name),
        entries: () => this.global.entries(),
      }),
      globalRefs: Object.freeze({
        lookup: (name: string) => this.globalRefs.lookup(name),
      }),
    });
  }

  /** Copy-on-write base for an incremental candidate. */
  fork(): WorkspaceIndex {
    const next = new WorkspaceIndex(
      this.recognizer,
      this.standalone,
      this.indexDocument,
      this.analyzeSource,
      {
        store: this.store.fork(),
        global: this.global.fork(),
        globalRefs: this.globalRefs.fork(),
        diskIndexes: this.diskIndexes,
      },
    );
    return next;
  }

  /** Restore a disk record while building from cache. */
  restoreFromCache(
    uri: string,
    index: FileIndex,
    source: DiskSourceIdentity = { mtimeMs: 0, size: 0 },
  ): void {
    const immutable = freezeFileIndex(index);
    this.diskIndexes = this.diskIndexes.set(uriKey(uri), Object.freeze({
      index: immutable,
      source: Object.freeze({ ...source }),
    }));
    this.setEffective(immutable);
  }

  diskIndexEntries(): Array<[string, FileIndex]> {
    return Array.from(
      this.diskIndexes.values(),
      ({ index }): [string, FileIndex] => [index.uri, index],
    );
  }

  diskCacheEntries(): Array<{ uri: string; index: FileIndex; source: DiskSourceIdentity }> {
    return Array.from(this.diskIndexes.values(), ({ index, source }) => ({
      uri: index.uri,
      index,
      source,
    }));
  }

  hasDiskIndex(uri: string): boolean {
    return this.diskIndexes.has(uriKey(uri));
  }

  diskFile(uri: string): FileIndex | undefined {
    return this.diskIndexes.get(uriKey(uri))?.index;
  }

  diskRecord(uri: string): DiskIndexRecord | undefined {
    return this.diskIndexes.get(uriKey(uri));
  }

  file(uri: string): FileIndex | undefined {
    return this.store.get(uri);
  }

  async indexAndStore(
    absPath: string,
    connection?: Connection,
    shouldStore: () => boolean = () => true,
  ): Promise<boolean> {
    const uri = pathToFileURL(absPath).href;
    const record = await this.indexDiskFile(uri, connection);
    if (!record || !shouldStore()) return false;
    this.diskIndexes = this.diskIndexes.set(uriKey(uri), record);
    this.setEffective(record.index);
    return true;
  }

  /**
   * Apply one canonicalized watcher batch without replacing an open overlay.
   * The caller supplies the live-attempt keys owned by the candidate revision.
   */
  async applyChanges(
    events: readonly FileEvent[],
    connection: Connection,
    liveUriKeys: ReadonlySet<string>,
    shouldStore: () => boolean = () => true,
  ): Promise<AppliedFileEvent[]> {
    const results: AppliedFileEvent[] = [];
    for (const event of collapseFileEvents(events)) {
      if (!shouldStore()) return results;
      const key = uriKey(event.uri);
      if (event.type === 'deleted') {
        const changedDisk = this.diskIndexes.has(key);
        this.diskIndexes = this.diskIndexes.delete(key);
        const changedEffective = !liveUriKeys.has(key) && this.store.get(event.uri) !== undefined;
        if (changedEffective) this.dropEffective(event.uri);
        results.push({
          ...event,
          indexed: true,
          changed: changedDisk || changedEffective,
        });
        continue;
      }

      const record = await this.indexDiskFile(event.uri, connection);
      if (!record || !shouldStore()) {
        results.push({ ...event, indexed: false, changed: false });
        continue;
      }
      this.diskIndexes = this.diskIndexes.set(key, record);
      if (!liveUriKeys.has(key)) this.setEffective(record.index);
      results.push({ ...event, indexed: true, changed: true });
    }
    return results;
  }

  /** Prepare a live document without mutating candidate state. */
  async prepareDocument(
    uri: string,
    text: string,
    shouldContinue: () => boolean = () => true,
    liveSession?: LiveDocumentTreeSession,
  ): Promise<PreparedDocumentIndex | undefined> {
    if (!shouldContinue()) return undefined;
    const liveAnalysis = this.analyzeSource(uri, text, 'full');
    const liveIndex = await this.createFileIndex(uri, text, liveAnalysis, liveSession);
    if (!shouldContinue()) return undefined;

    let diskIndex: DiskIndexRecord | null | undefined;
    if (this.standalone) {
      diskIndex = await this.readStandaloneDiskIndex(uri, text, liveIndex);
      if (!shouldContinue()) return undefined;
    }
    return {
      uri,
      liveIndex,
      liveAnalysis,
      diskIndex,
    };
  }

  commitDocument(
    candidate: PreparedDocumentIndex,
    shouldStore: () => boolean = () => true,
  ): boolean {
    if (!shouldStore()) return false;
    if (candidate.diskIndex === null) {
      this.diskIndexes = this.diskIndexes.delete(uriKey(candidate.uri));
    } else if (candidate.diskIndex !== undefined) {
      this.diskIndexes = this.diskIndexes.set(uriKey(candidate.uri), candidate.diskIndex);
    }
    this.setEffective(candidate.liveIndex);
    return true;
  }

  /** Restore a disk baseline or remove a live-only effective record. */
  async restoreClosedDocument(
    uri: string,
    shouldStore: () => boolean = () => true,
    allowDiskRead = true,
  ): Promise<boolean> {
    const diskIndex = this.diskIndexes.get(uriKey(uri));
    if (diskIndex) {
      if (!shouldStore()) return false;
      this.setEffective(diskIndex.index);
      return true;
    }

    const restored = allowDiskRead ? await this.indexDiskFile(uri) : undefined;
    if (!shouldStore()) return false;
    if (!restored) {
      this.dropEffective(uri);
      return true;
    }
    this.diskIndexes = this.diskIndexes.set(uriKey(uri), restored);
    this.setEffective(restored.index);
    return true;
  }

  private async indexDiskFile(
    uri: string,
    connection?: Connection,
  ): Promise<DiskIndexRecord | undefined> {
    const source = await readStableDiskSource(uri, connection);
    if (!source) return undefined;
    const index = await this.createFileIndex(uri, source.text);
    connection?.console.log(
      `[index] ${uri} -> ${index.symbols.length} symbols, ${index.references.length} refs`,
    );
    return Object.freeze({ index, source: source.identity });
  }

  private async readStandaloneDiskIndex(
    uri: string,
    liveText: string,
    liveIndex: FileIndex,
  ): Promise<DiskIndexRecord | null | undefined> {
    const source = await readStableDiskSource(uri);
    if (!source) return this.diskIndexes.has(uriKey(uri)) ? undefined : null;
    const index = source.text === liveText
      ? liveIndex
      : await this.createFileIndex(uri, source.text);
    return Object.freeze({ index, source: source.identity });
  }

  private async createFileIndex(
    uri: string,
    text: string,
    preparedAnalysis?: DocumentAnalysis,
    liveSession?: LiveDocumentTreeSession,
  ): Promise<FileIndex> {
    const analysis = preparedAnalysis ?? this.analyzeSource(uri, text, 'index');
    return freezeFileIndex(await this.indexDocument(
      uri,
      text,
      this.recognizer,
      analysis,
      liveSession,
    ));
  }

  private setEffective(index: FileIndex): void {
    this.store.set(index.uri, index);
    this.global.upsert(index);
    this.globalRefs.upsert(index);
  }

  private dropEffective(uri: string): void {
    this.store.delete(uri);
    this.global.delete(uri);
    this.globalRefs.delete(uri);
  }
}

function collapseFileEvents(events: readonly FileEvent[]): FileEvent[] {
  const byUri = new Map<string, FileEvent>();
  for (const event of events) byUri.set(uriKey(event.uri), event);
  return [...byUri.values()];
}

/**
 * FileIndex graphs are readonly by contract and shared by candidate forks.
 * Freeze only the public shell: recursively walking every symbol and range at
 * ingestion duplicated the parser's work on the latency-sensitive edit path.
 */
function freezeFileIndex(index: FileIndex): FileIndex {
  return Object.freeze(index);
}

async function readStableDiskSource(
  uri: string,
  connection?: Connection,
): Promise<{ text: string; identity: DiskSourceIdentity } | undefined> {
  const filePath = fileURLToPath(uri);
  let detail = 'source changed while it was being read';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const before = await fs.stat(filePath);
      const text = await fs.readFile(filePath, 'utf8');
      const after = await fs.stat(filePath);
      if (before.mtimeMs === after.mtimeMs && before.size === after.size) {
        return {
          text,
          identity: Object.freeze({ mtimeMs: after.mtimeMs, size: after.size }),
        };
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (typeof connection?.console.warn === 'function') {
    connection.console.warn(`[index] skipped unreadable source ${uri}: ${detail}`);
  }
  return undefined;
}
