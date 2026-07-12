import { fileURLToPath } from 'node:url';
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
import {
  normalizeSettings,
  settingsRequireReindex,
  type ExtensionSettings,
  type WorkspaceIndexStatus,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type {
  DefinitionAtInput,
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

type DesiredDocumentState =
  | { readonly kind: 'open'; readonly document: IndexedDocumentSnapshot }
  | {
    readonly kind: 'closed';
    readonly uri: string;
    readonly openId: number;
    readonly tombstone: boolean;
  };

type ClosedDocumentState = Extract<DesiredDocumentState, { readonly kind: 'closed' }>;

interface ReconciledClose {
  readonly key: string;
  readonly close: ClosedDocumentState;
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
  private operationTail: Promise<void> = Promise.resolve();
  private readonly desiredDocuments = new Map<string, DesiredDocumentState>();
  private readonly closedDocumentOpenIds = new Map<string, number>();
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
      || !this.acceptDocument(document)
    ) return Promise.resolve(false);
    if (this.published?.hasCommittedDocument(document)) return Promise.resolve(true);
    return this.reconcileDocumentAttempt(document);
  }

  closeDocument(input: { readonly uri: string; readonly openId: number }): Promise<void> {
    if (this.disposed || !this.acceptDocumentClose(input.uri, input.openId)) {
      return Promise.resolve();
    }
    return this.reconcileDocumentClose(input.uri, input.openId);
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

  private acceptDocument(document: IndexedDocumentSnapshot): boolean {
    const key = uriKey(document.uri);
    const closedOpenId = this.closedDocumentOpenIds.get(key);
    if (closedOpenId !== undefined && document.openId <= closedOpenId) return false;
    const current = this.desiredDocuments.get(key);
    if (current?.kind === 'open') {
      const previous = current.document;
      if (document.openId < previous.openId) return false;
      if (document.openId === previous.openId) {
        if (document.version < previous.version) return false;
        if (document.version === previous.version) {
          return document.languageId === previous.languageId
            && document.text === previous.text;
        }
      }
    } else if (current?.kind === 'closed') {
      if (document.openId < current.openId) return false;
      if (document.openId === current.openId && current.tombstone) return false;
    }
    this.desiredDocuments.set(key, { kind: 'open', document });
    return true;
  }

  private acceptDocumentClose(uri: string, openId: number): boolean {
    const key = uriKey(uri);
    const current = this.desiredDocuments.get(key);
    if (current?.kind === 'closed' && current.openId === openId && !current.tombstone) {
      this.desiredDocuments.set(key, { kind: 'closed', uri, openId, tombstone: true });
      return true;
    }
    if (current?.kind !== 'open' || openId !== current.document.openId) return false;
    this.desiredDocuments.set(key, { kind: 'closed', uri, openId, tombstone: true });
    return true;
  }

  private async reconcileDocumentAttempt(document: IndexedDocumentSnapshot): Promise<boolean> {
    while (this.isCurrentDocument(document)) {
      if (this.published?.hasCommittedDocument(document)) return true;
      await this.ensureDocumentReconcile(document.uri);
      if (!this.canServe()) return false;
    }
    return false;
  }

  private async reconcileDocumentClose(uri: string, openId: number): Promise<void> {
    const key = uriKey(uri);
    while (true) {
      const desired = this.desiredDocuments.get(key);
      if (desired?.kind !== 'closed' || desired.openId !== openId) return;
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
      while (!this.disposed && this.documentNeedsReconcile(key)) {
        const base = this.published;
        const desired = this.desiredDocuments.get(key);
        if (!base || !desired || !this.lifecycle.canServe()) return;
        const builder = base.fork();

        if (desired.kind === 'closed') {
          const isCurrent = (): boolean => (
            this.published === base && this.isCurrentClose(desired)
          );
          try {
            if (await builder.closeDocument(desired.uri, desired.openId, isCurrent)) {
              if (!isCurrent()) continue;
              this.publishIncremental(builder, [{ key, close: desired }]);
            }
          } catch (error) {
            if (!isCurrent()) continue;
            throw error;
          }
          continue;
        }

        const document = desired.document;
        const isCurrent = (): boolean => (
          this.published === base && this.isCurrentDocument(document)
        );
        try {
          const candidate = await builder.prepareDocument(document, isCurrent);
          if (!candidate) continue;
          if (builder.commitDocument(document, candidate, isCurrent)) {
            if (!isCurrent()) continue;
            this.publishIncremental(builder);
          }
        } catch (error) {
          if (!isCurrent()) continue;
          throw error;
        }
      }
    } finally {
      releaseRun?.();
    }
  }

  private documentNeedsReconcile(key: string): boolean {
    const desired = this.desiredDocuments.get(key);
    if (!desired) return false;
    return desired.kind === 'open'
      ? !this.published?.hasCommittedDocument(desired.document)
      : true;
  }

  private isCurrentDocument(document: IndexedDocumentSnapshot): boolean {
    if (this.disposed) return false;
    const desired = this.desiredDocuments.get(uriKey(document.uri));
    return desired?.kind === 'open'
      && desired.document.openId === document.openId
      && desired.document.version === document.version
      && desired.document.text === document.text
      && desired.document.languageId === document.languageId;
  }

  private isCurrentClose(close: Extract<DesiredDocumentState, { kind: 'closed' }>): boolean {
    if (this.disposed) return false;
    return this.desiredDocuments.get(uriKey(close.uri)) === close;
  }

  private captureOpenDocuments(synchronizeOwnership = false): void {
    const ownedKeys = new Set<string>();
    for (const document of this.openDocuments?.() ?? []) {
      if (!this.containsDocument(document.uri)) continue;
      ownedKeys.add(uriKey(document.uri));
      this.acceptDocument(document);
    }

    if (!synchronizeOwnership || !this.openDocuments) return;
    for (const [key, desired] of this.desiredDocuments) {
      if (desired.kind !== 'open' || ownedKeys.has(key)) continue;
      this.desiredDocuments.set(key, {
        kind: 'closed',
        uri: desired.document.uri,
        openId: desired.document.openId,
        tombstone: false,
      });
    }
  }

  private ownsProvidedDocument(document: IndexedDocumentSnapshot): boolean {
    if (!this.openDocuments) return true;
    for (const current of this.openDocuments()) {
      if (
        uriKey(current.uri) === uriKey(document.uri)
        && current.openId === document.openId
        && current.version === document.version
        && current.languageId === document.languageId
        && current.text === document.text
      ) return true;
    }
    return false;
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
  ): Promise<readonly ReconciledClose[]> {
    const reconciledCloses = new Map<string, ReconciledClose>();
    while (!this.disposed) {
      this.captureOpenDocuments(true);
      for (const [key, reconciled] of reconciledCloses) {
        if (this.desiredDocuments.get(key) !== reconciled.close) {
          reconciledCloses.delete(key);
        }
      }
      const pending = [...this.desiredDocuments.entries()]
        .filter(([key, desired]) => desired.kind === 'closed'
          ? reconciledCloses.get(key)?.close !== desired
          : !builder.hasCommittedDocument(desired.document));
      if (pending.length === 0) return [...reconciledCloses.values()];

      for (const [key, desired] of pending) {
        if (desired.kind === 'closed') {
          const isCurrent = () => this.isCurrentClose(desired);
          if (await builder.closeDocument(desired.uri, desired.openId, isCurrent)) {
            if (isCurrent()) reconciledCloses.set(key, { key, close: desired });
          }
          continue;
        }

        const document = desired.document;
        const isCurrent = () => this.isCurrentDocument(document);
        const candidate = await builder.prepareDocument(document, isCurrent);
        if (!candidate) continue;
        builder.commitDocument(document, candidate, isCurrent);
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
      for (const key of [...this.desiredDocuments.keys()]) {
        if (this.documentNeedsReconcile(key)) await this.performDocumentReconcile(key);
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
      if (!await builder.applyChanges(applicableEvents, connection, () => (
        !this.disposed && this.published === base
      ))) return;
      if (this.disposed || this.published !== base) return;
      const revision = this.publishIncremental(builder);
      await this.persistRevision(revision);
    } catch (error) {
      if (this.disposed || this.published !== base) return;
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
    reconciledCloses: readonly ReconciledClose[] = [],
  ): PublishedIndexedRevision {
    const next = this.lifecycle.nextRevision();
    const revision = builder.publish(next);
    this.published = revision;
    this.commitReconciledCloses(reconciledCloses);
    this.statusMode = revision.mode;
    const publishedNumber = this.lifecycle.complete(revision.sourceWarningCount);
    if (publishedNumber !== revision.revision) {
      throw new Error('Index lifecycle revision diverged from the published candidate');
    }
    return revision;
  }

  private publishIncremental(
    builder: IndexedRevisionBuilder,
    reconciledCloses: readonly ReconciledClose[] = [],
  ): PublishedIndexedRevision {
    const next = this.lifecycle.nextRevision();
    const revision = builder.publish(next);
    this.published = revision;
    this.commitReconciledCloses(reconciledCloses);
    this.statusMode = revision.mode;
    const publishedNumber = this.lifecycle.publish(revision.sourceWarningCount);
    if (publishedNumber !== revision.revision) {
      throw new Error('Index lifecycle revision diverged from the published candidate');
    }
    return revision;
  }

  private commitReconciledCloses(reconciledCloses: readonly ReconciledClose[]): void {
    for (const { key, close } of reconciledCloses) {
      if (this.desiredDocuments.get(key) !== close) continue;
      this.desiredDocuments.delete(key);
      if (close.tombstone) {
        this.closedDocumentOpenIds.set(
          key,
          Math.max(this.closedDocumentOpenIds.get(key) ?? -1, close.openId),
        );
      }
    }
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
