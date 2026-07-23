import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  CacheFingerprint,
  ExtensionSettings,
  FileIndex,
  IncludePointContext,
  IncludePointContextsResult,
  InactiveRegion,
  ShaderGraphCustomFunctionUsage,
  VariantContext,
  SelectedMaterialContext,
  PortabilityReport,
} from '@unity-shader-nav/shared';
import { normalizeSettings } from '@unity-shader-nav/shared';
import {
  analysisMatchesSource,
  type DocumentAnalysis,
} from '../analysis';
import type {
  CodeAction,
  CancellationToken,
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
import { isShaderLabUri, type ExactSource } from '../sourceLocation';
import type { PackageContext } from '../packages';
import { analyzeInactiveRegions } from '../parser/preproc/analyzeInactiveRegions';
import type { PreprocessorContext } from '../parser/preproc/context';
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
  PortabilityReportAtInput,
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
import {
  IncludePointContextMatrix,
  type ResolvedIncludePointContext,
} from './includePointContexts';
import { includePointContextStore } from './includePointContextStore';
import { variantContextStore } from './variantContextStore';
import {
  shaderGraphDefinition,
  shaderGraphDiagnostics,
  shaderGraphReferences,
} from './shaderGraphNavigation';
import {
  aggregateContextDiagnostics,
  analyzeKnownDiagnosticContexts,
  type DiagnosticShaderContext,
} from './diagnosticAggregation';
import { materialContextStore } from './materialContextStore';
import {
  annotateMaterialCompletions,
  rankMaterialDefinitionCandidates,
} from './materialContextOverlay';
import {
  createPortabilityReport,
  portabilityCodeActions,
  portabilityDiagnostics,
} from '../portability';
import { portabilityTargetStore } from '../portability/targetStore';

const PUBLICATION_SESSION_ID = randomUUID();
let nextPublicationIdentity = 1;

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
  readonly publicationId: string;
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
  private readonly includePointContexts: IncludePointContextMatrix;
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
    this.publicationId = `${PUBLICATION_SESSION_ID}:${nextPublicationIdentity++}`;
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
    this.includePointContexts = new IncludePointContextMatrix(index.read, this.includeChain);
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

  sourceTextFor(uri: string): string | undefined {
    return this.committedDocuments.get(uriKey(uri))?.source.sourceText;
  }

  indexedFile(uri: string): FileIndex | undefined {
    return this.index.read.store.get(uri);
  }

  diagnostics(uri: string): Promise<Diagnostic[]>;
  diagnostics(
    document: IndexedDocumentSnapshot,
    cancellation?: CancellationToken,
  ): Promise<Diagnostic[]>;
  async diagnostics(
    document: string | IndexedDocumentSnapshot,
    cancellation?: CancellationToken,
  ): Promise<Diagnostic[]> {
    const uri = typeof document === 'string' ? document : document.uri;
    const diagnostics = await workspaceDiagnostics({
      index: this.index.read,
      includeChain: this.includeChain,
    }, uri);
    if (typeof document === 'string') return diagnostics;
    const target = portabilityTargetStore.get(uri);
    if (target) {
      const report = this.portabilityReport({ document, target });
      if (report) diagnostics.push(...portabilityDiagnostics(report));
    }
    if (diagnostics.length === 0) return diagnostics;

    const variant = variantContextStore.get(uri);
    const selection = includePointContextStore.get(this.folderUri);
    const selectedIncludePoint = selection?.publicationId === this.publicationId
      ? await this.includePointContexts.recordFor(uri, selection.contextId)
      : undefined;
    if (selectedIncludePoint) {
      return filterDiagnosticsForContext(
        diagnostics,
        document,
        mergePreprocessorContext(variant, selectedIncludePoint),
      );
    }

    const records = await this.includePointContexts.recordsFor(uri);
    if (records.length > 0) {
      const contexts = records.map((record) => ({
        record,
        facts: staticDiagnosticContext(record, variant),
      }));
      const provenance = {
        kind: 'static',
        source: 'UnityShaderNav',
        revision: this.revision,
        publicationId: this.publicationId,
      } as const;
      const run = await analyzeKnownDiagnosticContexts({
        contexts,
        contextFacts: ({ facts }) => facts,
        cancellation,
        analyze: ({ record, facts }) => ({
          status: 'analyzed',
          context: facts,
          findings: filterDiagnosticsForContext(
            diagnostics,
            document,
            mergePreprocessorContext(variant, record),
          ).map((diagnostic) => ({ diagnostic, provenance })),
        }),
      });
      return aggregateContextDiagnostics({ uri, ...run });
    }

    const context = variant
      ? mergePreprocessorContext(variant, undefined)
      : undefined;
    if (!context) return diagnostics;
    return filterDiagnosticsForContext(diagnostics, document, context);
  }

  async knownIncludePointContexts(uri: string): Promise<IncludePointContextsResult> {
    const records = await this.includePointContexts.recordsFor(uri);
    return {
      folderUri: this.folderUri,
      revision: this.revision,
      publicationId: this.publicationId,
      contexts: records.map(({ presentation }) => presentation),
    };
  }

  async selectedIncludePointContext(): Promise<IncludePointContext | undefined> {
    const selection = includePointContextStore.get(this.folderUri);
    if (!selection || selection.publicationId !== this.publicationId) return undefined;
    return (await this.includePointContexts.recordById(selection.contextId))?.presentation;
  }

  async preprocessorContext(uri: string): Promise<PreprocessorContext | undefined> {
    const variant = variantContextStore.get(uri);
    const selection = includePointContextStore.get(this.folderUri);
    const includePoint = selection?.publicationId === this.publicationId
      ? await this.includePointContexts.recordFor(uri, selection.contextId)
      : undefined;
    if (!variant && !includePoint) return undefined;
    return {
      activeKeywords: variant?.activeKeywords ?? new Set(),
      definedMacros: includePoint?.preprocessor.definedMacros ?? new Set(),
      undefinedMacros: includePoint?.preprocessor.undefinedMacros ?? new Set(),
      variantKeywords: includePoint?.preprocessor.variantKeywords ?? new Set(),
    };
  }

  async inactiveRegions(uri: string, text: string): Promise<InactiveRegion[]> {
    return analyzeInactiveRegions(text, {
      isShaderLab: isShaderLabUri(uri),
      context: await this.preprocessorContext(uri),
    });
  }

  codeActions(input: CodeActionsAtInput): CodeAction[] {
    const index = this.index.read.store.get(input.document.uri);
    const materialActions = index
      ? srpBatcherCodeActions(
        index,
        input.document.uri,
        input.document.version,
        input.range,
        input.context,
      )
      : [];
    const target = portabilityTargetStore.get(input.document.uri);
    const report = target ? this.portabilityReport({
      document: input.document,
      target,
    }) : null;
    return report
      ? [
          ...materialActions,
          ...portabilityCodeActions(
            report,
            input.document.uri,
            input.document.version,
            input.range,
            input.context,
          ),
        ]
      : materialActions;
  }

  portabilityReport(input: PortabilityReportAtInput): PortabilityReport | null {
    const analysis = this.documentAnalysis({
      uri: input.document.uri,
      document: input.document,
    });
    if (!analysis) return null;
    return createPortabilityReport({
      uri: input.document.uri,
      source: analysis.sourceText,
      target: input.target,
      environment: {
        ...(this.project.editorVersion
          ? { unityVersion: this.project.editorVersion }
          : {}),
        renderPipelinePackages: this.packages.packages().map((pkg) => ({
          name: pkg.name,
          ...(pkg.version ? { version: pkg.version } : {}),
          ...(pkg.source ? { source: pkg.source } : {}),
          official: pkg.official,
        })),
      },
      ...(input.compilerResult ? { compilerResult: input.compilerResult } : {}),
    });
  }

  async definitionAt(
    input: DefinitionAtInput,
    facts?: CursorRequestFacts,
  ): Promise<LocationLink[] | Location[] | null> {
    const candidates = await navigateDefinition(
      this.navigationState(),
      input,
      facts,
      await this.preprocessorContext(input.document.uri),
    );
    const material = candidates
      ? await this.materialContextForUri(input.document.uri)
      : undefined;
    return candidates && material
      ? rankMaterialDefinitionCandidates(candidates, material)
      : candidates;
  }

  shaderGraphDefinitionAt(
    input: DefinitionAtInput,
    usages: readonly ShaderGraphCustomFunctionUsage[],
  ): LocationLink[] | null {
    return shaderGraphDefinition(this.navigationState(), input, usages);
  }

  shaderGraphDiagnostics(
    usages: readonly ShaderGraphCustomFunctionUsage[],
  ): Diagnostic[] {
    return shaderGraphDiagnostics(this.navigationState(), usages);
  }

  async shaderGraphReferencesAt(
    input: ReferencesAtInput,
    usages: readonly ShaderGraphCustomFunctionUsage[],
    facts?: CursorRequestFacts,
  ): Promise<Location[]> {
    return shaderGraphReferences(
      this.navigationState(),
      input,
      usages,
      facts,
      await this.preprocessorContext(input.document.uri),
    );
  }

  async referencesAt(
    input: ReferencesAtInput,
    facts?: CursorRequestFacts,
  ): Promise<Location[] | null> {
    return navigateReferences(
      this.navigationState(),
      input,
      facts,
      await this.preprocessorContext(input.document.uri),
    );
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

  async completionAt(
    input: DocumentPositionInput,
    facts?: CursorRequestFacts,
  ): Promise<CompletionItem[] | null> {
    const items = await queryCompletion(
      this.queryState(),
      input,
      this.documentAnalysis({ uri: input.document.uri, document: input.document }),
      facts,
      await this.preprocessorContext(input.document.uri),
    );
    const material = await this.materialContextForUri(input.document.uri);
    return items && material
      ? annotateMaterialCompletions(items, material)
      : items;
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

  async highlightsAt(
    input: DocumentPositionInput,
    facts?: CursorRequestFacts,
  ): Promise<DocumentHighlight[] | null> {
    return queryHighlights(
      this.queryState(),
      input,
      facts,
      await this.preprocessorContext(input.document.uri),
    );
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

  async semanticTokens(input: IndexedDocumentQueryInput): Promise<SemanticTokens> {
    return querySemanticTokens(
      this.queryState(),
      input,
      this.documentAnalysis(input)?.lexicalTokens,
      input.document ? await this.preprocessorContext(input.uri) : undefined,
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

  private async materialContextForUri(
    uri: string,
  ): Promise<SelectedMaterialContext | undefined> {
    const stored = materialContextStore.get(this.folderUri);
    if (!stored || stored.publicationId !== this.publicationId) return undefined;
    const context = stored.context;
    if (uriKey(context.shader.revision.uri) === uriKey(uri)) return context;
    const records = await this.includePointContexts.recordsFor(uri);
    return records.some(({ presentation }) => (
      uriKey(presentation.shaderUri) === uriKey(context.shader.revision.uri)
      && programMatchesMaterialContext(presentation, context)
    )) ? context : undefined;
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

function mergePreprocessorContext(
  variant: VariantContext | null,
  includePoint: ResolvedIncludePointContext | undefined,
): PreprocessorContext {
  return {
    activeKeywords: variant?.activeKeywords ?? new Set(),
    definedMacros: includePoint?.preprocessor.definedMacros ?? new Set(),
    undefinedMacros: includePoint?.preprocessor.undefinedMacros ?? new Set(),
    variantKeywords: includePoint?.preprocessor.variantKeywords ?? new Set(),
  };
}

function staticDiagnosticContext(
  record: ResolvedIncludePointContext,
  variant: VariantContext | null,
): DiagnosticShaderContext {
  const context = record.presentation;
  const declared = [...(record.preprocessor.variantKeywords ?? [])].sort();
  return {
    id: context.id,
    shader: {
      status: 'verified',
      value: { uri: context.shaderUri, name: context.shaderName },
    },
    pass: {
      status: 'verified',
      value: {
        subShaderIndex: context.subShaderIndex,
        ...(context.passIndex !== undefined ? { passIndex: context.passIndex } : {}),
        ...(context.passName ? { passName: context.passName } : {}),
      },
    },
    stage: {
      status: 'verified',
      value: { stage: context.stage, entryPoint: context.entryPoint },
    },
    includePoint: {
      status: 'verified',
      value: {
        location: context.includeLocation,
        chainDepth: context.chainDepth,
      },
    },
    keywords: variant
      ? {
          status: 'verified',
          value: {
            active: [...variant.activeKeywords].sort(),
            declared,
          },
        }
      : {
          status: 'unverified',
          reason: 'keyword-selection-not-enumerated',
          facts: { declared },
        },
    platform: {
      status: 'unverified',
      reason: 'adapter-evidence-unavailable',
    },
    graphicsApi: {
      status: 'unverified',
      reason: 'adapter-evidence-unavailable',
    },
  };
}

function filterDiagnosticsForContext(
  diagnostics: readonly Diagnostic[],
  document: IndexedDocumentSnapshot,
  context: PreprocessorContext,
): Diagnostic[] {
  const inactive = analyzeInactiveRegions(document.text, {
    isShaderLab: isShaderLabUri(document.uri),
    context,
  }).filter((region) => region.reason === 'inactive');
  return diagnostics.filter((diagnostic) => !inactive.some((region) => (
    region.range.start.line <= diagnostic.range.start.line
    && diagnostic.range.start.line <= region.range.end.line
  )));
}

function programMatchesMaterialContext(
  includePoint: IncludePointContext,
  context: SelectedMaterialContext,
): boolean {
  const selected = context.selectedProgram;
  if (!selected) return true;
  return includePoint.subShaderIndex === selected.subShaderIndex
    && (
      selected.passIndex === undefined
      || includePoint.passIndex === selected.passIndex
    )
    && (
      !selected.passName
      || !includePoint.passName
      || includePoint.passName === selected.passName
    );
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
