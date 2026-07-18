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
} from 'vscode-languageserver/node';
import {
  normalizeSettings,
  settingsRequireReindex,
  type ExtensionSettings,
  type WorkspaceIndexStatus,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
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
import type { FileEvent } from './workspaceIndex';

export type { FileEvent } from './workspaceIndex';

export interface WorkspaceRuntimeOptions
  extends Omit<DefaultIndexedRevisionCandidateConstructorOptions, 'folderUri'> {
  onIndexStatusChanged?: () => void;
  openDocuments?: OpenDocumentsProvider;
  candidateConstructor?: IndexedRevisionCandidateConstructor;
}

interface DocumentReconcileRun {
  promise: Promise<void>;
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
  /**
   * The lifecycle mutation queue for initialization, rebuilds, watcher updates,
   * and settings changes. Once an operation starts, no peer on this tail can
   * swap `published`; asynchronous work scheduled here only needs disposed,
   * abort, and domain-state guards—not another revision-equality check.
   */
  private operationTail: Promise<void> = Promise.resolve();
  private readonly documentReconciler = new OpenDocumentReconciler();
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

  updateDocument(document: IndexedDocumentSnapshot): Promise<boolean> {
    if (
      this.disposed
      || !this.ownsProvidedDocument(document)
      || !this.documentReconciler.acceptDocument(document)
    ) return Promise.resolve(false);
    if (this.published?.hasCommittedDocument(document)) return Promise.resolve(true);
    return this.reconcileDocumentAttempt(document);
  }

  closeDocument(input: { readonly uri: string; readonly openId: number }): Promise<void> {
    if (this.disposed || !this.documentReconciler.acceptClose(input.uri, input.openId)) {
      return Promise.resolve();
    }
    return this.reconcileDocumentClose(input.uri, input.openId);
  }

  async diagnosticsAt(document: IndexedDocumentSnapshot): Promise<Diagnostic[] | null> {
    const revision = await this.revisionForDocument(document);
    if (!revision) return null;
    const diagnostics = await revision.diagnostics(document.uri);
    return !this.disposed
      && this.published === revision
      && revision.hasCommittedDocument(document)
      ? diagnostics
      : null;
  }

  async codeActionsAt(input: CodeActionsAtInput): Promise<CodeAction[]> {
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return [];
    const actions = revision.codeActions(input);
    return !this.disposed && this.published === revision ? actions : [];
  }

  async definitionAt(
    input: DefinitionAtInput,
  ): Promise<LocationLink[] | Location[] | null> {
    if (canNavigateDefinitionWithoutDocumentIndex(input)) {
      const revision = this.captureServingRevision();
      if (!revision) return null;
      const result = await revision.definitionAt(input);
      return this.disposed ? null : result;
    }

    try {
      if (!await this.updateDocument(input.document)) return null;
    } catch {
      return null;
    }
    const revision = this.captureServingRevision();
    if (!revision?.hasCommittedDocument(input.document)) return null;
    const result = await revision.definitionAt(input);
    return this.disposed ? null : result;
  }

  async referencesAt(input: ReferencesAtInput): Promise<Location[] | null> {
    try {
      if (!await this.updateDocument(input.document)) return null;
    } catch {
      return null;
    }
    const revision = this.captureServingRevision();
    if (!revision?.hasCommittedDocument(input.document)) return null;
    const result = await revision.referencesAt(input);
    return this.disposed ? null : result;
  }

  async hoverAt(input: DocumentPositionInput): Promise<Hover | null> {
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return null;
    const result = await revision.hoverAt(input);
    return this.disposed ? null : result;
  }

  async completionAt(input: DocumentPositionInput): Promise<CompletionItem[] | null> {
    const withoutIndex = completionWithoutIndex(input);
    if (withoutIndex !== undefined) return withoutIndex;
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return null;
    const result = await revision.completionAt(input);
    return this.disposed ? null : result;
  }

  async documentColors(input: IndexedDocumentQueryInput): Promise<ColorInformation[]> {
    if (!input.document) return [];
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return [];
    const result = revision.documentColors(input);
    return this.disposed ? [] : result;
  }

  async colorPresentations(input: ColorPresentationAtInput): Promise<ColorPresentation[]> {
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return [];
    const result = revision.colorPresentations(input);
    return this.disposed ? [] : result;
  }

  async formatDocument(input: DocumentFormattingAtInput): Promise<TextEdit[] | null> {
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return null;
    const result = revision.formatDocument(input);
    return this.disposed ? null : result;
  }

  async signatureHelpAt(input: DocumentPositionInput): Promise<SignatureHelp | null> {
    if (!signatureHelpNeedsIndex(input)) return null;
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return null;
    const result = await revision.signatureHelpAt(input);
    return this.disposed ? null : result;
  }

  async highlightsAt(input: DocumentPositionInput): Promise<DocumentHighlight[] | null> {
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return null;
    const result = await revision.highlightsAt(input);
    return this.disposed ? null : result;
  }

  async prepareRenameAt(input: DocumentPositionInput): Promise<RenamePreparationOutcome> {
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return null;
    const result = await revision.prepareRenameAt(input);
    return this.disposed ? null : result;
  }

  async renameAt(
    input: DocumentPositionInput & { readonly newName: string },
  ): Promise<RenameEditOutcome> {
    const revision = await this.revisionForDocument(input.document);
    if (!revision) return null;
    const result = await revision.renameAt(input);
    return this.disposed ? null : result;
  }

  async documentSymbols(input: IndexedDocumentQueryInput): Promise<DocumentSymbol[] | null> {
    const revision = input.document
      ? await this.revisionForDocument(input.document)
      : this.captureServingRevision();
    return revision?.documentSymbols(input) ?? null;
  }

  async semanticTokens(input: IndexedDocumentQueryInput): Promise<SemanticTokens> {
    const revision = input.document
      ? await this.revisionForDocument(input.document)
      : this.captureServingRevision();
    return revision?.semanticTokens(input) ?? { data: [] };
  }

  workspaceSymbols(query: string): SymbolInformation[] {
    return this.captureServingRevision()?.workspaceSymbols(query) ?? [];
  }

  private async revisionForDocument(
    document: IndexedDocumentSnapshot,
  ): Promise<PublishedIndexedRevision | undefined> {
    try {
      if (!await this.updateDocument(document)) return undefined;
    } catch {
      return undefined;
    }
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
    while (!this.disposed && this.documentReconciler.isDesiredClose(uri, openId)) {
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
    run.promise = this.enqueueMutation(() => this.performDocumentReconcile(key, release))
      .catch((error: unknown) => {
        if (!this.disposed && this.lifecycle.snapshot().state === 'ready') {
          this.lifecycle.fail(error);
        }
        throw error;
      });
    return run.promise;
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
        );
        if (transition.kind === 'superseded') continue;
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
    this.documentReconciler.captureProvider(
      this.openDocuments,
      (uri) => this.containsDocument(uri),
      synchronizeOwnership,
    );
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
    this.documentReconciler.commitPublishedCloses(reconciledCloses);
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
