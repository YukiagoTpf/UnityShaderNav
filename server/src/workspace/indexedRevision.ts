import { pathToFileURL } from 'node:url';
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
  CodeAction,
  ColorInformation,
  ColorPresentation,
  CompletionItem,
  Connection,
  Diagnostic,
  DocumentHighlight,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
} from 'vscode-languageserver/node';
import type { CacheManager } from '../cache';
import type { LiveDocumentTreeSession } from '../parser/hlsl/liveDocumentTreeSession';
import {
  shaderLabColorPresentations,
  shaderLabDocumentColors,
  shaderLabIndentationEdits,
} from '../authoring';
import { createIncludeChain, type IncludeChain } from '../include';
import { DocumentationResolver } from '../documentation';
import { UnityProjectFacts } from '../project';
import { uriKey } from '../uriKey';
import type { ExactSource } from '../sourceLocation';
import type { PackageContext } from '../packages';
import {
  createSuggestionCandidateSelector,
  type SuggestionCandidateSelector,
} from '../suggestions';
import { IndexedSourceMembership } from './indexedSourceMembership';
import type {
  DefinitionAtInput,
  CodeActionsAtInput,
  ColorPresentationAtInput,
  DocumentFormattingAtInput,
  DocumentPositionInput,
  IndexedDocumentSnapshot,
  IndexedDocumentQueryInput,
  ReferencesAtInput,
  RenameEditOutcome,
  RenamePreparationOutcome,
} from './indexedWorkspace';
import type { CursorRequestFacts } from './requestFacts';
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
  prepareWorkspaceRename,
  renameWorkspaceSymbol,
} from './rename';
import { workspaceDiagnostics } from './diagnostics';
import { srpBatcherCodeActions } from './materialContracts';
import {
  WorkspaceIndex,
  type DocumentAnalyzer,
  type DiskIndexRecord,
  type DiskSourceIdentity,
  type DocumentIndexer,
  type FileEvent,
  type PreparedDocumentIndex,
} from './workspaceIndex';
import {
  materialPropertyTargetAt,
  type MaterialPropertyTarget,
} from './materialReferences';

export interface CommittedDocumentAttempt {
  readonly openId: number;
  readonly version: number;
  readonly analysis: DocumentAnalysis | undefined;
  readonly source: ExactSource;
}

export interface IndexedRevisionConfiguration {
  readonly folderUri: string;
  readonly settings: ExtensionSettings;
  readonly unityRoot: string | undefined;
  readonly packages: PackageContext;
  readonly project: UnityProjectFacts;
  readonly membership: IndexedSourceMembership;
  readonly cache: CacheManager | undefined;
  readonly fingerprint: CacheFingerprint | undefined;
}

type IndexedRevisionConfigurationInput = Omit<
  IndexedRevisionConfiguration,
  'membership' | 'project'
> & {
  readonly membership?: IndexedSourceMembership;
  readonly project?: UnityProjectFacts;
};

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
  readonly project: UnityProjectFacts;
  readonly membership: IndexedSourceMembership;
  readonly cache: CacheManager | undefined;
  readonly fingerprint: CacheFingerprint | undefined;
  readonly sourceWarningCount: number;
  private readonly index: WorkspaceIndex;
  private readonly includeChain: IncludeChain;
  private readonly suggestionCandidates: SuggestionCandidateSelector;
  private readonly documentation: DocumentationResolver;
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
    this.project = configuration.project;
    this.membership = configuration.membership;
    this.cache = configuration.cache;
    this.fingerprint = configuration.fingerprint;
    this.index = index;
    const packageIncludeContext = configuration.packages.includeCtx;
    this.includeChain = createIncludeChain(
      index.read.store,
      {
        ...packageIncludeContext,
        includeDirectories: configuration.settings.includeDirectories,
      },
    );
    this.suggestionCandidates = createSuggestionCandidateSelector(
      index.read,
      this.includeChain,
    );
    this.documentation = new DocumentationResolver(configuration.packages, configuration.project);
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
    return this.index.hasDiskIndex(uri) || this.membership.containsUri(uri);
  }

  diagnostics(uri: string): Promise<Diagnostic[]> {
    return workspaceDiagnostics({
      index: this.index.read,
      includeChain: this.includeChain,
    }, uri);
  }

  codeActions(input: CodeActionsAtInput): CodeAction[] {
    const index = this.index.read.store.get(input.document.uri);
    return index
      ? srpBatcherCodeActions(
        index,
        input.document.uri,
        input.document.version,
        input.range,
        input.context,
      )
      : [];
  }

  definitionAt(
    input: DefinitionAtInput,
    facts?: CursorRequestFacts,
  ): Promise<LocationLink[] | Location[] | null> {
    return navigateDefinition(this.navigationState(), input, facts);
  }

  referencesAt(
    input: ReferencesAtInput,
    facts?: CursorRequestFacts,
  ): Promise<Location[] | null> {
    return navigateReferences(this.navigationState(), input, facts);
  }

  materialPropertyTargetAt(input: DocumentPositionInput): MaterialPropertyTarget | undefined {
    return materialPropertyTargetAt(
      this.index.read.store.get(input.document.uri),
      input.position,
    );
  }

  hoverAt(
    input: DocumentPositionInput,
    facts?: CursorRequestFacts,
  ): Promise<Hover | null> {
    return queryHover(
      this.queryState(),
      input,
      this.documentAnalysis({ uri: input.document.uri, document: input.document })?.lexicalTokens,
      facts,
    );
  }

  completionAt(
    input: DocumentPositionInput,
    facts?: CursorRequestFacts,
  ): Promise<CompletionItem[] | null> {
    return queryCompletion(
      this.queryState(),
      input,
      this.documentAnalysis({ uri: input.document.uri, document: input.document }),
      facts,
    );
  }

  requestSource(document: IndexedDocumentSnapshot): ExactSource | undefined {
    const committed = this.committedDocuments.get(uriKey(document.uri));
    if (
      !committed
      || committed.openId !== document.openId
      || committed.version !== document.version
      || committed.source.sourceText !== document.text
    ) return undefined;
    return committed.source;
  }

  documentColors(input: IndexedDocumentQueryInput): ColorInformation[] {
    return shaderLabDocumentColors(this.documentAnalysis(input));
  }

  colorPresentations(input: ColorPresentationAtInput): ColorPresentation[] {
    return shaderLabColorPresentations(
      this.documentAnalysis({ uri: input.document.uri, document: input.document }),
      input.range,
      input.color,
    );
  }

  formatDocument(input: DocumentFormattingAtInput): TextEdit[] | null {
    return shaderLabIndentationEdits(
      this.documentAnalysis({ uri: input.document.uri, document: input.document }),
      input.document.text,
      input.options,
    );
  }

  signatureHelpAt(
    input: DocumentPositionInput,
    facts?: CursorRequestFacts,
  ): Promise<SignatureHelp | null> {
    return querySignatureHelp(this.queryState(), input, facts);
  }

  highlightsAt(
    input: DocumentPositionInput,
    facts?: CursorRequestFacts,
  ): Promise<DocumentHighlight[] | null> {
    return queryHighlights(this.queryState(), input, facts);
  }

  prepareRenameAt(
    input: DocumentPositionInput,
    facts?: CursorRequestFacts,
  ): Promise<RenamePreparationOutcome> {
    return prepareWorkspaceRename(this.navigationState(), input, facts);
  }

  renameAt(
    input: DocumentPositionInput & { readonly newName: string },
    facts?: CursorRequestFacts,
  ): Promise<RenameEditOutcome> {
    return renameWorkspaceSymbol(this.navigationState(), input, facts);
  }

  documentSymbols(input: IndexedDocumentQueryInput): DocumentSymbol[] | null {
    return queryDocumentSymbols(this.queryState(), input);
  }

  semanticTokens(input: IndexedDocumentQueryInput): Promise<SemanticTokens> {
    return querySemanticTokens(
      this.queryState(),
      input,
      this.documentAnalysis(input)?.lexicalTokens,
    );
  }

  workspaceSymbols(
    query: string,
  ): SymbolInformation[];
  workspaceSymbols(
    query: string,
    cancellation: import('vscode-languageserver/node').CancellationToken,
  ): Promise<SymbolInformation[]>;
  workspaceSymbols(
    query: string,
    cancellation?: import('vscode-languageserver/node').CancellationToken,
  ): SymbolInformation[] | Promise<SymbolInformation[]> {
    return cancellation
      ? queryWorkspaceSymbols(this.queryState(), query, cancellation)
      : queryWorkspaceSymbols(this.queryState(), query);
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
    const membership = settings === this.settings
      ? this.membership
      : IndexedSourceMembership.create({
        folderUri: this.folderUri,
        settings,
        unityRoot: this.unityRoot,
        packages: this.packages,
      });
    return new IndexedRevisionBuilder(
      {
        folderUri: this.folderUri,
        settings: immutableSettings(settings),
        unityRoot: this.unityRoot,
        packages: this.packages,
        project: this.project,
        membership,
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
      includeChain: this.includeChain,
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
      includeChain: this.includeChain,
      includePackages: this.settings.findReferences.includePackages,
      suggestionCandidates: this.suggestionCandidates,
      documentation: this.documentation,
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
    configuration: IndexedRevisionConfigurationInput,
    indexDocument?: DocumentIndexer,
    analyzeDocument?: DocumentAnalyzer,
  ): IndexedRevisionBuilder {
    const settings = immutableSettings(configuration.settings);
    const membership = configuration.membership ?? IndexedSourceMembership.create({
      folderUri: configuration.folderUri,
      settings,
      unityRoot: configuration.unityRoot,
      packages: configuration.packages,
    });
    return new IndexedRevisionBuilder(
      {
        ...configuration,
        settings,
        membership,
        project: configuration.project ?? UnityProjectFacts.unknown(),
      },
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
    liveSession?: LiveDocumentTreeSession,
    source?: ExactSource,
  ): Promise<PreparedDocumentIndex | undefined> {
    this.assertMutable();
    return this.index.prepareDocument(
      document.uri,
      document.text,
      shouldContinue,
      liveSession,
      source,
    );
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
      source: candidate.liveSource,
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
      this.configuration.membership.containsUri(uri),
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
