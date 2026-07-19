import { fileURLToPath } from 'node:url';
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
  CancellationToken,
} from 'vscode-languageserver/node';
import {
  normalizeSettings,
  settingsRequireReindex,
  type ExtensionSettings,
  type IncludePointContextsResult,
  type InactiveRegion,
  type WorkspaceIndexStatus,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type { ExactSource } from '../sourceLocation';
import {
  awaitWithRequestCancellation,
  isRequestCancelledError,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import type {
  DefinitionAtInput,
  CodeActionsAtInput,
  ColorPresentationAtInput,
  DocumentFormattingAtInput,
  DocumentPositionInput,
  IndexedDocumentSnapshot,
  IndexedDocumentQueryInput,
  IndexedWorkspace,
  OpenDocumentsProvider,
  ReferencesAtInput,
  RenameEditOutcome,
  RenamePreparationOutcome,
} from './indexedWorkspace';
import { canNavigateDefinitionWithoutDocumentIndex } from './navigation';
import { containsPath } from './pathUtils';
import { IndexLifecycle } from './indexLifecycle';
import {
  OpenDocumentReconciler,
  type ReconciledDocumentClose,
} from './openDocumentReconciler';
import {
  createDefaultIndexedRevisionCandidateConstructor,
  createStandalonePackageContext,
  type DefaultIndexedRevisionCandidateConstructorOptions,
  type IndexedRevisionCandidateConstructor,
} from './indexedRevisionCandidate';
import {
  IndexedRevisionBuilder,
  PublishedIndexedRevision,
} from './indexedRevision';
import {
  completionWithoutIndex,
  signatureHelpNeedsIndex,
} from './queries';
import { createCursorRequestFacts } from './requestFacts';
import type { FileEvent } from './workspaceIndex';
import {
  LiveDocumentTreeSessions,
  type LiveDocumentTreeSessionFactory,
} from './liveDocumentTreeSessions';
import {
  materialPropertyReferences,
  type MaterialPropertyTarget,
} from './materialReferences';
import type { MaterialUsageProvider } from '../adapter/materialSource';

export type { FileEvent } from './workspaceIndex';

export interface WorkspaceRuntimeOptions
  extends Omit<DefaultIndexedRevisionCandidateConstructorOptions, 'folderUri'> {
  onIndexStatusChanged?: () => void;
  openDocuments?: OpenDocumentsProvider;
  candidateConstructor?: IndexedRevisionCandidateConstructor;
  createLiveDocumentTreeSession?: LiveDocumentTreeSessionFactory;
  materialUsages?: MaterialUsageProvider;
}

interface DocumentReconcileRun {
  promise: Promise<void>;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if (
    value === null
    || (typeof value !== 'object' && typeof value !== 'function')
  ) return false;
  return typeof (value as { readonly then?: unknown }).then === 'function';
}

/**
 * Lifecycle owner for one root. Only `published` is request-visible; every
 * mutation builds an isolated candidate and swaps this pointer once.
 */
export class Workspace implements IndexedWorkspace {
  readonly folderUri: string;
  private requestedSettings: ExtensionSettings;
  private statusMode: WorkspaceIndexStatus['mode'];
  private published: PublishedIndexedRevision | undefined;
  private globalStorageDir: string | undefined;
  private readonly lifecycle: IndexLifecycle;
  private readonly candidateConstructor: IndexedRevisionCandidateConstructor;
  private readonly openDocuments: OpenDocumentsProvider | undefined;
  private readonly materialUsages: MaterialUsageProvider | undefined;
  /**
   * The lifecycle mutation queue for initialization, rebuilds, watcher updates,
   * and settings changes. Once an operation starts, no peer on this tail can
   * swap `published`; asynchronous work scheduled here only needs disposed,
   * abort, and domain-state guards—not another revision-equality check.
   */
  private operationTail: Promise<void> = Promise.resolve();
  private readonly documentReconciler = new OpenDocumentReconciler();
  private readonly liveDocumentTrees: LiveDocumentTreeSessions;
  private readonly documentReconciles = new Map<string, DocumentReconcileRun>();
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(
    folderUri: string,
    settings: ExtensionSettings,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.folderUri = folderUri;
    this.requestedSettings = normalizeSettings(settings);
    this.statusMode = this.requestedSettings.projectRoot.trim() ? 'unity' : 'standalone';
    this.lifecycle = new IndexLifecycle(options.onIndexStatusChanged);
    this.candidateConstructor = options.candidateConstructor
      ?? createDefaultIndexedRevisionCandidateConstructor(folderUri, options);
    this.openDocuments = options.openDocuments;
    this.materialUsages = options.materialUsages;
    this.liveDocumentTrees = new LiveDocumentTreeSessions(
      options.createLiveDocumentTreeSession,
    );
  }

  /** Latest published settings, or requested settings before the first publish. */
  get settings(): ExtensionSettings {
    return this.published?.settings ?? this.requestedSettings;
  }

  get unityRoot(): string | undefined {
    return this.published?.unityRoot;
  }

  get packages(): PublishedIndexedRevision['packages'] {
    return this.published?.packages ?? createStandalonePackageContext(this.requestedSettings);
  }

  isStandalone(): boolean {
    return this.published?.isStandalone() ?? !this.requestedSettings.projectRoot.trim();
  }

  containsIndexedUri(uri: string): boolean {
    return this.published?.containsIndexedUri(uri) ?? false;
  }

  indexStatus(): WorkspaceIndexStatus {
    return {
      folderUri: this.folderUri,
      mode: this.published?.mode ?? this.statusMode,
      lifecycle: this.lifecycle.snapshot(),
    };
  }

  canServe(): boolean {
    return !this.disposed && this.published !== undefined && this.lifecycle.canServe();
  }

  updateDocument(
    document: IndexedDocumentSnapshot,
    source?: ExactSource,
  ): Promise<boolean> {
    if (
      this.disposed
      || !this.ownsProvidedDocument(document)
      || !this.documentReconciler.acceptDocument(document, source)
    ) return Promise.resolve(false);
    if (this.published?.hasCommittedDocument(document)) return Promise.resolve(true);
    return this.reconcileDocumentAttempt(document);
  }

  closeDocument(input: { readonly uri: string; readonly openId: number }): Promise<void> {
    if (this.disposed || !this.documentReconciler.acceptClose(input.uri, input.openId)) {
      return Promise.resolve();
    }
    this.liveDocumentTrees.close(input.uri, input.openId);
    return this.reconcileDocumentClose(input.uri, input.openId);
  }

  async diagnosticsAt(document: IndexedDocumentSnapshot): Promise<Diagnostic[] | null> {
    return this.queryRevision<Diagnostic[] | null>(
      document,
      null,
      (revision) => revision.diagnostics(document),
      undefined,
      undefined,
      (revision) => (
        !this.disposed
        && this.published === revision
        && revision.hasCommittedDocument(document)
      ),
    );
  }

  async knownIncludePointContextsAt(
    document: IndexedDocumentSnapshot,
  ): Promise<IncludePointContextsResult> {
    return this.queryRevision(
      document,
      { contexts: [] },
      (revision) => revision.knownIncludePointContexts(document.uri),
    );
  }

  async inactiveRegionsAt(
    document: IndexedDocumentSnapshot,
  ): Promise<InactiveRegion[]> {
    return this.queryRevision(
      document,
      [],
      (revision) => revision.inactiveRegions(document.uri, document.text),
    );
  }

  async codeActionsAt(input: CodeActionsAtInput): Promise<CodeAction[]> {
    throwIfRequestCancelled(input.cancellation);
    return this.queryRevision<CodeAction[]>(
      input.document,
      [],
      (revision) => revision.codeActions(input),
      input.cancellation,
      undefined,
      (revision) => !this.disposed && this.published === revision,
    );
  }

  async definitionAt(
    input: DefinitionAtInput,
  ): Promise<LocationLink[] | Location[] | null> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    if (canNavigateDefinitionWithoutDocumentIndex(input, facts)) {
      return this.queryRevision(
        undefined,
        null,
        (revision) => revision.definitionAt(input, facts),
        input.cancellation,
        facts.source,
      );
    }
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.definitionAt(input, facts),
      input.cancellation,
      facts.source,
    );
  }

  async referencesAt(input: ReferencesAtInput): Promise<Location[] | null> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    const result = await this.queryRevision<{
      readonly sourceLocations: Location[] | null;
      readonly materialTarget: MaterialPropertyTarget | undefined;
    }>(
      input.document,
      { sourceLocations: null, materialTarget: undefined },
      async (revision) => ({
        sourceLocations: await revision.referencesAt(input, facts),
        materialTarget: revision.materialPropertyTargetAt(input),
      }),
      input.cancellation,
      facts.source,
    );
    if (!this.materialUsages || !result.materialTarget || this.disposed) {
      return result.sourceLocations;
    }
    const materialLocations = await materialPropertyReferences(
      input.document.uri,
      result.materialTarget,
      this.materialUsages,
      input.cancellation,
    );
    if (this.disposed || materialLocations.length === 0) return result.sourceLocations;
    return [...(result.sourceLocations ?? []), ...materialLocations];
  }

  async hoverAt(input: DocumentPositionInput): Promise<Hover | null> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.hoverAt(input, facts),
      input.cancellation,
      facts.source,
    );
  }

  async completionAt(input: DocumentPositionInput): Promise<CompletionItem[] | null> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    const withoutIndex = completionWithoutIndex(input, facts);
    if (withoutIndex !== undefined) return withoutIndex;
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.completionAt(input, facts),
      input.cancellation,
      facts.source,
    );
  }

  async documentColors(input: IndexedDocumentQueryInput): Promise<ColorInformation[]> {
    throwIfRequestCancelled(input.cancellation);
    if (!input.document) return [];
    return this.queryRevision<ColorInformation[]>(
      input.document,
      [],
      (revision) => revision.documentColors(input),
      input.cancellation,
    );
  }

  async colorPresentations(input: ColorPresentationAtInput): Promise<ColorPresentation[]> {
    throwIfRequestCancelled(input.cancellation);
    return this.queryRevision<ColorPresentation[]>(
      input.document,
      [],
      (revision) => revision.colorPresentations(input),
      input.cancellation,
    );
  }

  async formatDocument(input: DocumentFormattingAtInput): Promise<TextEdit[] | null> {
    throwIfRequestCancelled(input.cancellation);
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.formatDocument(input),
      input.cancellation,
    );
  }

  async signatureHelpAt(input: DocumentPositionInput): Promise<SignatureHelp | null> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    if (!signatureHelpNeedsIndex(input, facts)) return null;
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.signatureHelpAt(input, facts),
      input.cancellation,
      facts.source,
    );
  }

  async highlightsAt(input: DocumentPositionInput): Promise<DocumentHighlight[] | null> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.highlightsAt(input, facts),
      input.cancellation,
      facts.source,
    );
  }

  async prepareRenameAt(input: DocumentPositionInput): Promise<RenamePreparationOutcome> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.prepareRenameAt(input, facts),
      input.cancellation,
      facts.source,
    );
  }

  async renameAt(
    input: DocumentPositionInput & { readonly newName: string },
  ): Promise<RenameEditOutcome> {
    throwIfRequestCancelled(input.cancellation);
    const facts = createCursorRequestFacts(
      input.document,
      input.position,
      this.captureServingRevision()?.requestSource(input.document),
    );
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.renameAt(input, facts),
      input.cancellation,
      facts.source,
    );
  }

  async documentSymbols(input: IndexedDocumentQueryInput): Promise<DocumentSymbol[] | null> {
    throwIfRequestCancelled(input.cancellation);
    return this.queryRevision(
      input.document,
      null,
      (revision) => revision.documentSymbols(input),
      input.cancellation,
    );
  }

  async semanticTokens(input: IndexedDocumentQueryInput): Promise<SemanticTokens> {
    throwIfRequestCancelled(input.cancellation);
    return this.queryRevision(
      input.document,
      { data: [] },
      (revision) => revision.semanticTokens(input),
      input.cancellation,
    );
  }

  workspaceSymbols(
    query: string,
  ): SymbolInformation[];
  workspaceSymbols(
    query: string,
    cancellation: CancellationToken,
  ): Promise<SymbolInformation[]>;
  workspaceSymbols(
    query: string,
    cancellation?: CancellationToken,
  ): SymbolInformation[] | Promise<SymbolInformation[]> {
    throwIfRequestCancelled(cancellation);
    const revision = this.captureServingRevision();
    if (!revision) return cancellation ? Promise.resolve([]) : [];
    return cancellation
      ? revision.workspaceSymbols(query, cancellation)
      : revision.workspaceSymbols(query);
  }

  /**
   * Capture one request-visible revision, run one query against that immutable
   * snapshot, then apply the caller's publication guard or return its neutral
   * protocol value. Synchronous revision queries stay synchronous through the
   * guard so disposal cannot be observed at a new microtask boundary.
   */
  private async queryRevision<TResult>(
    document: IndexedDocumentSnapshot | undefined,
    neutral: TResult,
    query: (revision: PublishedIndexedRevision) => TResult | PromiseLike<TResult>,
    cancellation?: CancellationToken,
    source?: ExactSource,
    guard: (revision: PublishedIndexedRevision) => boolean = () => !this.disposed,
  ): Promise<TResult> {
    throwIfRequestCancelled(cancellation);
    const revision = document
      ? await this.revisionForDocument(document, cancellation, source)
      : this.captureServingRevision();
    throwIfRequestCancelled(cancellation);
    if (!revision) return neutral;

    const result = query(revision);
    if (isPromiseLike(result)) {
      const resolved = await awaitWithRequestCancellation(result, cancellation);
      throwIfRequestCancelled(cancellation);
      return guard(revision) ? resolved : neutral;
    }
    return guard(revision) ? result : neutral;
  }

  private async revisionForDocument(
    document: IndexedDocumentSnapshot,
    cancellation?: CancellationToken,
    source?: ExactSource,
  ): Promise<PublishedIndexedRevision | undefined> {
    try {
      if (!await awaitWithRequestCancellation(
        this.updateDocument(document, source),
        cancellation,
      )) return undefined;
    } catch (error) {
      if (isRequestCancelledError(error)) throw error;
      return undefined;
    }
    throwIfRequestCancelled(cancellation);
    const revision = this.captureServingRevision();
    return revision?.hasCommittedDocument(document) ? revision : undefined;
  }

  private captureServingRevision(): PublishedIndexedRevision | undefined {
    return this.canServe() ? this.published : undefined;
  }

  private async reconcileDocumentAttempt(document: IndexedDocumentSnapshot): Promise<boolean> {
    while (!this.disposed && this.documentReconciler.isCurrentDocument(document)) {
      if (this.published?.hasCommittedDocument(document)) return true;
      await this.ensureDocumentReconcile(document.uri);
      if (!this.canServe()) return false;
    }
    return false;
  }

  private async reconcileDocumentClose(uri: string, openId: number): Promise<void> {
    const key = uriKey(uri);
    while (
      !this.disposed
      && this.documentReconciler.isDesiredClose(uri, openId)
      && this.documentReconciler.needsReconcile(key, this.published)
    ) {
      await this.ensureDocumentReconcile(uri);
      if (!this.canServe()) return;
    }
  }

  private ensureDocumentReconcile(uri: string): Promise<void> {
    const key = uriKey(uri);
    const existing = this.documentReconciles.get(key);
    if (existing) return existing.promise;

    const run: DocumentReconcileRun = { promise: Promise.resolve() };
    this.documentReconciles.set(key, run);
    const release = (): void => {
      if (this.documentReconciles.get(key) === run) this.documentReconciles.delete(key);
    };
    const operation = this.canReconcileAlongsideFullCandidate()
      ? this.performDocumentReconcile(key, release)
      : this.enqueueMutation(() => this.performDocumentReconcile(key, release));
    run.promise = operation
      .catch((error: unknown) => {
        if (!this.disposed && this.lifecycle.snapshot().state === 'ready') {
          this.lifecycle.fail(error);
        }
        throw error;
      });
    return run.promise;
  }

  private canReconcileAlongsideFullCandidate(): boolean {
    const lifecycle = this.lifecycle.snapshot();
    return lifecycle.state === 'indexing' && lifecycle.servingRevision !== undefined;
  }

  private async performDocumentReconcile(key: string, releaseRun?: () => void): Promise<void> {
    try {
      while (!this.disposed && this.documentReconciler.needsReconcile(key, this.published)) {
        const base = this.published;
        const desired = this.documentReconciler.desired(key);
        if (!base || !desired || !this.lifecycle.canServe()) return;
        const builder = base.fork();
        const transition = await this.documentReconciler.apply(
          builder,
          key,
          desired,
          () => !this.disposed && this.published === base,
          desired.kind === 'open'
            ? () => this.liveDocumentTrees.sessionFor(desired.document)
            : undefined,
        );
        if (transition.kind === 'superseded') continue;
        if (
          this.disposed
          || this.published !== base
          || this.documentReconciler.desired(key) !== desired
        ) continue;
        this.publishIncremental(
          builder,
          transition.kind === 'closed' ? [transition.reconciled] : [],
        );
      }
    } finally {
      releaseRun?.();
    }
  }

  private captureOpenDocuments(synchronizeOwnership = false): void {
    const documents = this.openDocuments ? [...this.openDocuments()] : undefined;
    this.documentReconciler.captureProvider(
      documents ? () => documents : undefined,
      (uri) => this.containsDocument(uri),
      synchronizeOwnership,
    );
    if (synchronizeOwnership && documents) {
      this.liveDocumentTrees.retainOnly(
        documents.filter((document) => this.containsDocument(document.uri)),
      );
    }
  }

  private ownsProvidedDocument(document: IndexedDocumentSnapshot): boolean {
    return this.documentReconciler.ownsSnapshot(document, this.openDocuments);
  }

  private containsDocument(uri: string): boolean {
    try {
      return containsPath(fileURLToPath(this.folderUri), fileURLToPath(uri));
    } catch {
      return false;
    }
  }

  private async reconcileOpenDocumentsBeforePublish(
    builder: IndexedRevisionBuilder,
  ): Promise<readonly ReconciledDocumentClose[]> {
    const reconciledCloses = new Map<string, ReconciledDocumentClose>();
    while (!this.disposed) {
      this.captureOpenDocuments(true);
      const pending = this.documentReconciler.pendingTransitions(builder, reconciledCloses);
      if (pending.length === 0) return [...reconciledCloses.values()];

      for (const [key, desired] of pending) {
        const transition = await this.documentReconciler.apply(
          builder,
          key,
          desired,
          () => !this.disposed,
          desired.kind === 'open'
            ? () => this.liveDocumentTrees.sessionFor(desired.document)
            : undefined,
        );
        if (transition.kind === 'closed') {
          reconciledCloses.set(key, transition.reconciled);
        }
      }
    }
    return [];
  }

  /** Reconcile live-document ownership after routing topology changes. */
  synchronizeOpenDocuments(): Promise<void> {
    if (!this.canServe()) return Promise.resolve();
    return this.enqueueMutation(async () => {
      if (this.disposed || !this.lifecycle.canServe()) return;
      this.captureOpenDocuments(true);
      for (const key of this.documentReconciler.keysNeedingReconcile(this.published)) {
        await this.performDocumentReconcile(key);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.liveDocumentTrees.dispose();
    this.abortController.abort(new WorkspaceDisposedError(this.folderUri));
  }

  initialize(connection: Connection, globalStorageDir?: string): Promise<void> {
    return this.enqueueMutation(() => this.performInitialize(connection, globalStorageDir));
  }

  private async performInitialize(
    connection: Connection,
    globalStorageDir?: string,
  ): Promise<void> {
    this.globalStorageDir = globalStorageDir;
    try {
      if (this.disposed) return;
      const builder = await this.constructCandidate(connection, globalStorageDir);
      const reconciledCloses = await this.reconcileOpenDocumentsBeforePublish(builder);
      if (this.disposed) return;
      const revision = this.publishComplete(builder, reconciledCloses);
      await this.persistRevision(revision);
    } catch (error) {
      if (this.disposed) return;
      this.documentReconciler.releasePublishedCloses();
      this.lifecycle.fail(error);
      throw error;
    }
  }

  private constructCandidate(
    connection: Connection,
    globalStorageDir: string | undefined,
  ): Promise<IndexedRevisionBuilder> {
    return this.candidateConstructor.construct({
      connection,
      settings: this.requestedSettings,
      globalStorageDir,
      previous: this.published,
      signal: this.abortController.signal,
      // Candidate construction reports a detected-root fact; Workspace alone
      // owns the observable mode. This preserves pre-publication Unity mode
      // when a later package/parser step fails during initial construction.
      onModeResolved: (mode) => {
        if (!this.published) this.statusMode = mode;
      },
    });
  }

  reconfigure(connection: Connection, settings: ExtensionSettings): Promise<boolean> {
    const requested = normalizeSettings(settings);
    return this.enqueueMutation(async () => {
      if (this.disposed) return false;
      const base = this.published;
      this.requestedSettings = requested;
      if (!base || settingsRequireReindex(base.settings, requested)) {
        await this.performRebuild(connection, requested);
        return !this.disposed;
      }
      if (JSON.stringify(base.settings) === JSON.stringify(requested)) return false;
      const builder = base.fork(requested);
      this.publishIncremental(builder);
      return false;
    });
  }

  applyChanges(events: FileEvent[], connection: Connection): Promise<void> {
    return this.enqueueMutation(() => this.performApplyChanges(events, connection));
  }

  private async performApplyChanges(events: FileEvent[], connection: Connection): Promise<void> {
    const base = this.published;
    if (
      this.disposed
      || !base
      || !this.lifecycle.canApplyIncrementalChanges()
      || events.length === 0
    ) return;
    const applicableEvents = events.filter((event) => base.containsIndexedUri(event.uri));
    if (applicableEvents.length === 0) return;

    const builder = base.fork();
    try {
      if (!await builder.applyChanges(
        applicableEvents,
        connection,
        () => !this.disposed,
      )) return;
      if (this.disposed) return;
      const revision = this.publishIncremental(builder);
      await this.persistRevision(revision);
    } catch (error) {
      if (this.disposed) return;
      this.lifecycle.fail(error);
      throw error;
    }
  }

  rebuild(connection: Connection, settings?: ExtensionSettings): Promise<void> {
    const explicitSettings = settings === undefined ? undefined : normalizeSettings(settings);
    return this.enqueueMutation(() => this.performRebuild(
      connection,
      explicitSettings ?? this.requestedSettings,
    ));
  }

  private async performRebuild(
    connection: Connection,
    settings: ExtensionSettings,
  ): Promise<void> {
    if (this.disposed) return;
    this.requestedSettings = settings;
    this.lifecycle.begin(this.lifecycle.nextRebuildOperation());
    try {
      const builder = await this.constructCandidate(connection, this.globalStorageDir);
      const reconciledCloses = await this.reconcileOpenDocumentsBeforePublish(builder);
      if (this.disposed) return;
      const revision = this.publishComplete(builder, reconciledCloses);
      await this.persistRevision(revision);
    } catch (error) {
      if (this.disposed) return;
      this.documentReconciler.releasePublishedCloses();
      this.lifecycle.fail(error);
      throw error;
    }
  }

  private publishComplete(
    builder: IndexedRevisionBuilder,
    reconciledCloses: readonly ReconciledDocumentClose[] = [],
  ): PublishedIndexedRevision {
    const next = this.lifecycle.nextRevision();
    const revision = builder.publish(next);
    this.published = revision;
    this.documentReconciler.commitPublishedCloses(reconciledCloses);
    this.statusMode = revision.mode;
    const publishedNumber = this.lifecycle.complete(revision.sourceWarningCount);
    if (publishedNumber !== revision.revision) {
      throw new Error('Index lifecycle revision diverged from the published candidate');
    }
    return revision;
  }

  private publishIncremental(
    builder: IndexedRevisionBuilder,
    reconciledCloses: readonly ReconciledDocumentClose[] = [],
  ): PublishedIndexedRevision {
    const next = this.lifecycle.nextRevision();
    const revision = builder.publish(next);
    this.published = revision;
    this.documentReconciler.commitPublishedCloses(
      reconciledCloses,
      this.canReconcileAlongsideFullCandidate(),
    );
    this.statusMode = revision.mode;
    const publishedNumber = this.lifecycle.publish(revision.sourceWarningCount);
    if (publishedNumber !== revision.revision) {
      throw new Error('Index lifecycle revision diverged from the published candidate');
    }
    return revision;
  }

  persist(): Promise<void> {
    const revision = this.published;
    return revision ? this.persistRevision(revision) : Promise.resolve();
  }

  private async persistRevision(revision: PublishedIndexedRevision): Promise<void> {
    if (this.disposed || !revision.cache || !revision.fingerprint) return;
    try {
      await revision.cache.persistPublication({
        workspaceFolderUri: revision.folderUri,
        unityProjectRoot: revision.unityRoot ?? null,
        fingerprint: revision.fingerprint,
        files: revision.diskCacheEntries(),
      }, () => !this.disposed && this.published === revision);
    } catch {
      // Cache persistence is derived, best-effort work.
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class WorkspaceDisposedError extends Error {
  constructor(folderUri: string) {
    super(`Workspace was removed while indexing: ${folderUri}`);
    this.name = 'WorkspaceDisposedError';
  }
}
