import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  CacheFingerprint,
  ExtensionSettings,
  FileIndex,
} from '@unity-shader-nav/shared';
import { normalizeSettings } from '@unity-shader-nav/shared';
import {
  analysisMatchesSource,
  type DocumentAnalysis,
} from '../analysis';
import type {
  CompletionItem,
  Connection,
  DocumentHighlight,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
} from 'vscode-languageserver/node';
import type { CacheManager } from '../cache';
import { uriKey } from '../uriKey';
import type { PackageContext } from '../packages';
import {
  createSuggestionCandidateSelector,
  type SuggestionCandidateSelector,
} from '../suggestions';
import { containsPath } from './pathUtils';
import { isIndexableFilePath } from './walkFiles';
import type {
  DefinitionAtInput,
  DocumentPositionInput,
  IndexedDocumentSnapshot,
  IndexedDocumentQueryInput,
  ReferencesAtInput,
} from './indexedWorkspace';
import {
  navigateDefinition,
  navigateReferences,
  type WorkspaceNavigationState,
} from './navigation';
import {
  queryCompletion,
  queryDocumentSymbols,
  queryHighlights,
  queryHover,
  querySemanticTokens,
  querySignatureHelp,
  queryWorkspaceSymbols,
  type WorkspaceQueryState,
} from './queries';
import {
  WorkspaceIndex,
  type DocumentAnalyzer,
  type DiskIndexRecord,
  type DiskSourceIdentity,
  type DocumentIndexer,
  type FileEvent,
  type PreparedDocumentIndex,
} from './workspaceIndex';

export interface CommittedDocumentAttempt {
  readonly openId: number;
  readonly version: number;
  readonly analysis: DocumentAnalysis | undefined;
}

export interface IndexedRevisionConfiguration {
  readonly folderUri: string;
  readonly settings: ExtensionSettings;
  readonly unityRoot: string | undefined;
  readonly packages: PackageContext;
  readonly cache: CacheManager | undefined;
  readonly fingerprint: CacheFingerprint | undefined;
}

/**
 * One immutable, request-capturable Workspace publication. Its index
 * implementation and identity maps are private; mutation starts by forking a
 * separate builder and cannot affect this object.
 */
export class PublishedIndexedRevision {
  readonly revision: number;
  readonly folderUri: string;
  readonly settings: ExtensionSettings;
  readonly unityRoot: string | undefined;
  readonly packages: PackageContext;
  readonly cache: CacheManager | undefined;
  readonly fingerprint: CacheFingerprint | undefined;
  readonly sourceWarningCount: number;
  private readonly index: WorkspaceIndex;
  private readonly suggestionCandidates: SuggestionCandidateSelector;
  private readonly committedDocuments: ReadonlyMap<string, CommittedDocumentAttempt>;
  private readonly sourceWarnings: ReadonlySet<string>;

  constructor(
    revision: number,
    configuration: IndexedRevisionConfiguration,
    index: WorkspaceIndex,
    committedDocuments: ReadonlyMap<string, CommittedDocumentAttempt>,
    sourceWarnings: ReadonlySet<string>,
  ) {
    this.revision = revision;
    this.folderUri = configuration.folderUri;
    this.settings = configuration.settings;
    this.unityRoot = configuration.unityRoot;
    this.packages = configuration.packages;
    this.cache = configuration.cache;
    this.fingerprint = configuration.fingerprint;
    this.index = index;
    this.suggestionCandidates = createSuggestionCandidateSelector(
      index.read,
      configuration.packages.includeCtx,
    );
    this.committedDocuments = new Map(committedDocuments);
    this.sourceWarnings = new Set(sourceWarnings);
    this.sourceWarningCount = this.sourceWarnings.size;
  }

  get mode(): 'unity' | 'standalone' {
    return this.unityRoot ? 'unity' : 'standalone';
  }

  isStandalone(): boolean {
    return this.unityRoot === undefined;
  }

  hasCommittedDocument(document: IndexedDocumentSnapshot): boolean {
    const committed = this.committedDocuments.get(uriKey(document.uri));
    return committed?.openId === document.openId
      && committed.version === document.version;
  }

  containsIndexedUri(uri: string): boolean {
    return this.index.hasDiskIndex(uri) || isUriInConfiguredScope(
      uri,
      this.folderUri,
      this.settings,
      this.unityRoot,
      this.packages,
    );
  }

  definitionAt(input: DefinitionAtInput): Promise<LocationLink[] | Location[] | null> {
    return navigateDefinition(this.navigationState(), input);
  }

  referencesAt(input: ReferencesAtInput): Promise<Location[] | null> {
    return navigateReferences(this.navigationState(), input);
  }

  hoverAt(input: DocumentPositionInput): Promise<Hover | null> {
    return queryHover(this.queryState(), input);
  }

  completionAt(input: DocumentPositionInput): Promise<CompletionItem[] | null> {
    return queryCompletion(this.queryState(), input);
  }

  signatureHelpAt(input: DocumentPositionInput): Promise<SignatureHelp | null> {
    return querySignatureHelp(this.queryState(), input);
  }

  highlightsAt(input: DocumentPositionInput): Promise<DocumentHighlight[] | null> {
    return queryHighlights(this.queryState(), input);
  }

  documentSymbols(input: IndexedDocumentQueryInput): DocumentSymbol[] | null {
    return queryDocumentSymbols(this.queryState(), input);
  }

  semanticTokens(input: IndexedDocumentQueryInput): SemanticTokens {
    return querySemanticTokens(
      this.queryState(),
      input,
      this.documentAnalysis(input)?.lexicalTokens,
    );
  }

  workspaceSymbols(query: string): SymbolInformation[] {
    return queryWorkspaceSymbols(this.queryState(), query);
  }

  diskIndexEntries(): Array<[string, FileIndex]> {
    return this.index.diskIndexEntries();
  }

  diskFile(uri: string): FileIndex | undefined {
    return this.index.diskFile(uri);
  }

  diskRecord(uri: string): DiskIndexRecord | undefined {
    return this.index.diskRecord(uri);
  }

  diskCacheEntries(): Array<{
    uri: string;
    index: FileIndex;
    source: DiskSourceIdentity;
  }> {
    return this.index.diskCacheEntries();
  }

  fork(settings: ExtensionSettings = this.settings): IndexedRevisionBuilder {
    return new IndexedRevisionBuilder(
      {
        folderUri: this.folderUri,
        settings: immutableSettings(settings),
        unityRoot: this.unityRoot,
        packages: this.packages,
        cache: this.cache,
        fingerprint: this.fingerprint,
      },
      this.index.fork(),
      new Map(this.committedDocuments),
      new Set(this.sourceWarnings),
    );
  }

  private navigationState(): WorkspaceNavigationState {
    return {
      index: this.index.read,
      includeCtx: this.packages.includeCtx,
      isInPackages: (uri) => this.packages.isInPackages(uri),
      includePackages: this.settings.findReferences.includePackages,
      definitionTrace: this.settings.debug.definitionTrace,
    };
  }

  private queryState(): WorkspaceQueryState {
    return {
      folderUri: this.folderUri,
      index: this.index.read,
      packages: this.packages,
      includePackages: this.settings.findReferences.includePackages,
      suggestionCandidates: this.suggestionCandidates,
    };
  }

  private documentAnalysis(input: IndexedDocumentQueryInput): DocumentAnalysis | undefined {
    if (!input.document || uriKey(input.document.uri) !== uriKey(input.uri)) return undefined;
    const committed = this.committedDocuments.get(uriKey(input.uri));
    if (
      !committed
      || committed.openId !== input.document.openId
      || committed.version !== input.document.version
      || !committed.analysis
      || !analysisMatchesSource(committed.analysis, input.document.text)
    ) return undefined;
    return committed.analysis;
  }
}

/** One-shot mutable candidate. It becomes inaccessible after publish(). */
export class IndexedRevisionBuilder {
  readonly configuration: IndexedRevisionConfiguration;
  private readonly index: WorkspaceIndex;
  private readonly committedDocuments: Map<string, CommittedDocumentAttempt>;
  private readonly sourceWarnings: Set<string>;
  private published = false;

  constructor(
    configuration: IndexedRevisionConfiguration,
    index: WorkspaceIndex,
    committedDocuments = new Map<string, CommittedDocumentAttempt>(),
    sourceWarnings = new Set<string>(),
  ) {
    this.configuration = {
      ...configuration,
      settings: immutableSettings(configuration.settings),
      fingerprint: configuration.fingerprint
        ? Object.freeze({ ...configuration.fingerprint })
        : undefined,
    };
    this.index = index;
    this.committedDocuments = committedDocuments;
    this.sourceWarnings = sourceWarnings;
  }

  static create(
    configuration: IndexedRevisionConfiguration,
    indexDocument?: DocumentIndexer,
    analyzeDocument?: DocumentAnalyzer,
  ): IndexedRevisionBuilder {
    const settings = immutableSettings(configuration.settings);
    return new IndexedRevisionBuilder(
      { ...configuration, settings },
      new WorkspaceIndex(
        settings.declarationMacros,
        configuration.unityRoot === undefined,
        indexDocument,
        analyzeDocument,
      ),
    );
  }

  get warningCount(): number {
    return this.sourceWarnings.size;
  }

  file(uri: string): FileIndex | undefined {
    return this.index.file(uri);
  }

  hasCommittedDocument(document: IndexedDocumentSnapshot): boolean {
    const committed = this.committedDocuments.get(uriKey(document.uri));
    return committed?.openId === document.openId
      && committed.version === document.version;
  }

  liveUriKeys(): ReadonlySet<string> {
    return new Set(this.committedDocuments.keys());
  }

  restoreFromCache(
    uri: string,
    index: FileIndex,
    source?: DiskSourceIdentity,
  ): void {
    this.assertMutable();
    this.index.restoreFromCache(uri, index, source);
  }

  diskIndexEntries(): Array<[string, FileIndex]> {
    return this.index.diskIndexEntries();
  }

  hasDiskIndex(uri: string): boolean {
    return this.index.hasDiskIndex(uri);
  }

  async indexAndStore(
    absPath: string,
    connection: Connection,
    shouldStore: () => boolean = () => true,
  ): Promise<boolean> {
    this.assertMutable();
    const indexed = await this.index.indexAndStore(absPath, connection, shouldStore);
    const uri = pathToFileURL(absPath).href;
    this.recordSourceResult(uri, indexed);
    return indexed;
  }

  async applyChanges(
    events: readonly FileEvent[],
    connection: Connection,
    shouldStore: () => boolean = () => true,
  ): Promise<boolean> {
    this.assertMutable();
    const results = await this.index.applyChanges(
      events,
      connection,
      this.liveUriKeys(),
      shouldStore,
    );
    let changed = false;
    for (const result of results) {
      const key = uriKey(result.uri);
      const warnedBefore = this.sourceWarnings.has(key);
      if (result.type === 'deleted' || result.indexed) {
        this.sourceWarnings.delete(key);
      } else {
        this.sourceWarnings.add(key);
      }
      changed ||= result.changed || warnedBefore !== this.sourceWarnings.has(key);
    }
    return changed;
  }

  prepareDocument(
    document: IndexedDocumentSnapshot,
    shouldContinue: () => boolean,
  ): Promise<PreparedDocumentIndex | undefined> {
    this.assertMutable();
    return this.index.prepareDocument(document.uri, document.text, shouldContinue);
  }

  commitDocument(
    document: IndexedDocumentSnapshot,
    candidate: PreparedDocumentIndex,
    shouldStore: () => boolean,
  ): boolean {
    this.assertMutable();
    if (!this.index.commitDocument(candidate, shouldStore)) return false;
    this.committedDocuments.set(uriKey(document.uri), Object.freeze({
      openId: document.openId,
      version: document.version,
      analysis: candidate.liveAnalysis,
    }));
    return true;
  }

  async closeDocument(
    uri: string,
    openId: number,
    shouldStore: () => boolean,
  ): Promise<boolean> {
    this.assertMutable();
    const committed = this.committedDocuments.get(uriKey(uri));
    if (committed && committed.openId !== openId) return false;
    if (!await this.index.restoreClosedDocument(
      uri,
      shouldStore,
      isUriInConfiguredScope(
        uri,
        this.configuration.folderUri,
        this.configuration.settings,
        this.configuration.unityRoot,
        this.configuration.packages,
      ),
    )) return false;
    this.committedDocuments.delete(uriKey(uri));
    return true;
  }

  removeCommittedDocument(uri: string): void {
    this.assertMutable();
    this.committedDocuments.delete(uriKey(uri));
  }

  recordSourceResult(uri: string, indexed: boolean): void {
    this.assertMutable();
    if (indexed) this.sourceWarnings.delete(uriKey(uri));
    else this.sourceWarnings.add(uriKey(uri));
  }

  publish(revision: number): PublishedIndexedRevision {
    this.assertMutable();
    this.published = true;
    return new PublishedIndexedRevision(
      revision,
      this.configuration,
      this.index,
      this.committedDocuments,
      this.sourceWarnings,
    );
  }

  private assertMutable(): void {
    if (this.published) throw new Error('Indexed revision candidate was already published');
  }
}

function immutableSettings(settings: ExtensionSettings): ExtensionSettings {
  const snapshot = normalizeSettings(settings);
  for (const macro of snapshot.declarationMacros) Object.freeze(macro);
  Object.freeze(snapshot.includeDirectories);
  Object.freeze(snapshot.excludePatterns);
  Object.freeze(snapshot.declarationMacros);
  Object.freeze(snapshot.findReferences);
  Object.freeze(snapshot.debug);
  Object.freeze(snapshot.dimInactiveBranches);
  return Object.freeze(snapshot);
}

function isUriInConfiguredScope(
  uri: string,
  folderUri: string,
  settings: ExtensionSettings,
  unityRoot: string | undefined,
  packages: PackageContext,
): boolean {
  try {
    const filePath = fileURLToPath(uri);
    if (!unityRoot) {
      return isIndexableFilePath(
        fileURLToPath(folderUri),
        filePath,
        settings.excludePatterns,
      );
    }

    const packageRoot = packages.packageRoots().find((root) => containsPath(root, filePath));
    if (packageRoot) {
      return isIndexableFilePath(
        packageRoot,
        filePath,
        ['**/Documentation~/**', '**/Samples~/**'],
      );
    }

    return isIndexableFilePath(
      unityRoot,
      filePath,
      [...settings.excludePatterns, 'Packages/**'],
    );
  } catch {
    return false;
  }
}
