import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  type CacheFingerprint,
  type CacheManifest,
  type ExtensionSettings,
  type WorkspaceIndexStatus,
} from '@unity-shader-nav/shared';
import { CacheManager, cacheWorkspaceMatches } from '../cache';
import { buildFingerprint } from '../cache/fingerprint';
import { INDEX_IMPLEMENTATION_IDENTITY } from '../cache/implementationIdentity';
import { PackageContext } from '../packages';
import { ensureParserReady } from '../parser/hlsl';
import { uriKey } from '../uriKey';
import type {
  DefinitionAtInput,
  DocumentPositionInput,
  IndexedDocumentSnapshot,
  IndexedDocumentQueryInput,
  IndexedWorkspace,
  OpenDocumentsProvider,
  ReferencesAtInput,
} from './indexedWorkspace';
import { canNavigateDefinitionWithoutDocumentIndex } from './navigation';
import { detectUnityRoot } from './detectUnityRoot';
import { containsPath } from './pathUtils';
import { mapWithConcurrency } from './concurrency';
import { IndexInfrastructureError, IndexLifecycle } from './indexLifecycle';
import {
  IndexedRevisionBuilder,
  PublishedIndexedRevision,
} from './indexedRevision';
import {
  completionWithoutIndex,
  signatureHelpNeedsIndex,
} from './queries';
import type {
  DocumentAnalyzer,
  DocumentIndexer,
  FileEvent,
} from './workspaceIndex';
import { walkFiles } from './walkFiles';

export type { FileEvent } from './workspaceIndex';

const INDEX_CONCURRENCY = 8;
const CACHE_IO_CONCURRENCY = 32;

export interface WorkspaceRuntimeOptions {
  indexImplementation?: string | null;
  onIndexStatusChanged?: () => void;
  ensureParserReady?: () => Promise<void>;
  indexDocument?: DocumentIndexer;
  analyzeDocument?: DocumentAnalyzer;
  openDocuments?: OpenDocumentsProvider;
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

interface CacheConfiguration {
  readonly cache: CacheManager | undefined;
  readonly fingerprint: CacheFingerprint | undefined;
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
  private stagedCandidate: IndexedRevisionBuilder | undefined;
  private globalStorageDir: string | undefined;
  private readonly indexImplementation: string | null;
  private readonly lifecycle: IndexLifecycle;
  private readonly parserReady: () => Promise<void>;
  private readonly indexDocument: DocumentIndexer | undefined;
  private readonly analyzeDocument: DocumentAnalyzer | undefined;
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
    this.indexImplementation = options.indexImplementation === undefined
      ? INDEX_IMPLEMENTATION_IDENTITY ?? null
      : options.indexImplementation;
    this.lifecycle = new IndexLifecycle(options.onIndexStatusChanged);
    this.parserReady = options.ensureParserReady ?? ensureParserReady;
    this.indexDocument = options.indexDocument;
    this.analyzeDocument = options.analyzeDocument;
    this.openDocuments = options.openDocuments;
  }

  /** Latest published settings, or requested settings before the first publish. */
  get settings(): ExtensionSettings {
    return this.published?.settings ?? this.requestedSettings;
  }

  get unityRoot(): string | undefined {
    return this.published?.unityRoot;
  }

  get packages(): PackageContext {
    return this.published?.packages ?? PackageContext.standalone(this.requestedSettings);
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
      await this.bootstrap(connection, globalStorageDir);
      const builder = this.takeStagedCandidate();
      const reconciledCloses = await this.reconcileOpenDocumentsBeforePublish(builder);
      if (this.disposed) return;
      const revision = this.publishComplete(builder, reconciledCloses);
      await this.persistRevision(revision);
    } catch (error) {
      this.stagedCandidate = undefined;
      if (this.disposed) return;
      this.lifecycle.fail(error);
      throw error;
    }
  }

  /** Build and stage a candidate; publication remains the caller's responsibility. */
  async bootstrap(connection: Connection, globalStorageDir?: string): Promise<number> {
    const builder = await this.buildCandidate(
      connection,
      this.requestedSettings,
      globalStorageDir,
      this.published,
    );
    this.stagedCandidate = builder;
    return builder.warningCount;
  }

  private takeStagedCandidate(): IndexedRevisionBuilder {
    const staged = this.stagedCandidate;
    this.stagedCandidate = undefined;
    if (staged) return staged;

    // Test seams may stub bootstrap only to control timing. Preserve the
    // published base when present; initial stubs receive an empty candidate.
    if (this.published) return this.published.fork(this.requestedSettings);
    const unityRoot = this.requestedSettings.projectRoot.trim() || undefined;
    return IndexedRevisionBuilder.create({
      folderUri: this.folderUri,
      settings: this.requestedSettings,
      unityRoot,
      packages: PackageContext.standalone(this.requestedSettings),
      cache: undefined,
      fingerprint: undefined,
    }, this.indexDocument, this.analyzeDocument);
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
      await this.bootstrap(connection, this.globalStorageDir);
      const builder = this.takeStagedCandidate();
      const reconciledCloses = await this.reconcileOpenDocumentsBeforePublish(builder);
      if (this.disposed) return;
      const revision = this.publishComplete(builder, reconciledCloses);
      await this.persistRevision(revision);
    } catch (error) {
      this.stagedCandidate = undefined;
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

  private async buildCandidate(
    connection: Connection,
    settings: ExtensionSettings,
    globalStorageDir: string | undefined,
    previous: PublishedIndexedRevision | undefined,
  ): Promise<IndexedRevisionBuilder> {
    this.throwIfDisposed();
    const folderPath = fileURLToPath(this.folderUri);
    const configuredRoot = settings.projectRoot.trim();
    const unityRoot = configuredRoot || await detectUnityRoot(folderPath) || undefined;
    this.throwIfDisposed();
    if (!this.published) this.statusMode = unityRoot ? 'unity' : 'standalone';

    let packages: PackageContext;
    if (!unityRoot) {
      packages = PackageContext.standalone(settings);
    } else {
      try {
        packages = await PackageContext.load(unityRoot, settings);
        this.throwIfDisposed();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new IndexInfrastructureError('package-resolution', message, { cause: error });
      }
    }

    await this.preflightParser();
    const cacheConfiguration = await this.configureCache(
      folderPath,
      unityRoot,
      settings,
      globalStorageDir,
      connection,
    );
    const builder = IndexedRevisionBuilder.create({
      folderUri: this.folderUri,
      settings,
      unityRoot,
      packages,
      ...cacheConfiguration,
    }, this.indexDocument, this.analyzeDocument);
    const compatiblePrevious = this.isCompatiblePrevious(
      previous,
      unityRoot,
      packages,
      cacheConfiguration.fingerprint,
    );

    const manifest = await cacheConfiguration.cache?.load(cacheConfiguration.fingerprint);
    this.throwIfDisposed();
    if (manifest && cacheWorkspaceMatches(manifest, {
      workspaceFolderUri: this.folderUri,
      unityProjectRoot: unityRoot ?? null,
    })) {
      await this.bootstrapFromCache(
        connection,
        builder,
        manifest,
        cacheConfiguration.cache!,
        unityRoot,
        packages,
        previous,
        compatiblePrevious,
      );
      return builder;
    }

    if (unityRoot) {
      await this.fullScan(
        connection,
        builder,
        unityRoot,
        packages,
        settings,
        previous,
        compatiblePrevious,
      );
    }
    return builder;
  }

  private async preflightParser(): Promise<void> {
    try {
      await this.parserReady();
      this.throwIfDisposed();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new IndexInfrastructureError(
        'parser-initialization',
        `Unable to initialize the shader parser: ${message}`,
        { cause: error },
      );
    }
  }

  private async configureCache(
    folderPath: string,
    unityRoot: string | undefined,
    settings: ExtensionSettings,
    globalStorageDir: string | undefined,
    connection: Connection,
  ): Promise<CacheConfiguration> {
    let cache = CacheManager.create({
      unityProjectRoot: unityRoot,
      workspaceFolderUri: this.folderUri,
      globalStorageDir,
    });
    if (!cache) return { cache: undefined, fingerprint: undefined };

    const fingerprint = await buildFingerprint(
      settings,
      this.resolveWasmPath(folderPath),
      this.indexImplementation ?? undefined,
    );
    this.throwIfDisposed();
    if (!fingerprint) {
      connection.console.warn(
        'Index cache disabled: the running index implementation could not be identified.',
      );
      cache = undefined;
    }
    return { cache, fingerprint: cache ? fingerprint : undefined };
  }

  private resolveWasmPath(folderPath: string): string {
    const candidates = [
      join(__dirname, '..', '..', 'grammars', 'tree-sitter-hlsl.wasm'),
      join(__dirname, '..', 'grammars', 'tree-sitter-hlsl.wasm'),
      join(folderPath, 'server', 'grammars', 'tree-sitter-hlsl.wasm'),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }

  private async bootstrapFromCache(
    connection: Connection,
    builder: IndexedRevisionBuilder,
    manifest: CacheManifest,
    cache: CacheManager,
    unityRoot: string | undefined,
    packages: PackageContext,
    previous: PublishedIndexedRevision | undefined,
    compatiblePrevious: boolean,
  ): Promise<void> {
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'restoring cache...', false);
    const refreshQueue: string[] = [];
    try {
      const restoreResults = await mapWithConcurrency(
        manifest.files,
        CACHE_IO_CONCURRENCY,
        async (cachedFile) => {
          this.throwIfDisposed();
          const valid = this.shouldRestoreCachedFile(cachedFile.uri, packages)
            && await cache.isValid(cachedFile);
          this.throwIfDisposed();
          return { cachedFile, valid };
        },
      );

      for (const { cachedFile, valid } of restoreResults) {
        this.throwIfDisposed();
        if (!this.shouldRestoreCachedFile(cachedFile.uri, packages)) continue;
        if (valid) {
          builder.restoreFromCache(cachedFile.uri, cachedFile.index, {
            mtimeMs: cachedFile.mtimeMs,
            size: cachedFile.size,
          });
        }
        else if (await fileExists(cachedFile.uri)) refreshQueue.push(cachedFile.uri);
      }

      progress.report(`re-parsing ${refreshQueue.length} changed files...`);
      await mapWithConcurrency(refreshQueue, INDEX_CONCURRENCY, async (uri) => {
        this.throwIfDisposed();
        const indexed = await builder.indexAndStore(
          fileURLToPath(uri),
          connection,
          () => !this.disposed,
        );
        this.throwIfDisposed();
        this.retainCompatibleSourceFailure(
          builder,
          uri,
          indexed,
          previous,
          compatiblePrevious,
        );
      });
      if (unityRoot) {
        await this.indexMissingDiskFiles(
          connection,
          builder,
          unityRoot,
          packages,
          manifest.files,
          previous,
          compatiblePrevious,
        );
      }
    } finally {
      progress.done();
    }
  }

  private shouldRestoreCachedFile(
    uri: string,
    packages: PackageContext,
  ): boolean {
    return packages.canRestoreCachedFile(uri);
  }

  private async indexMissingDiskFiles(
    connection: Connection,
    builder: IndexedRevisionBuilder,
    unityRoot: string,
    packages: PackageContext,
    _cachedFiles: readonly { uri: string }[],
    previous: PublishedIndexedRevision | undefined,
    compatiblePrevious: boolean,
  ): Promise<void> {
    const userFiles = await walkFiles(
      unityRoot,
      [...builder.configuration.settings.excludePatterns, 'Packages/**'],
      this.abortController.signal,
    );
    await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (filePath) => {
      this.throwIfDisposed();
      const uri = pathToFileURL(filePath).href;
      if (builder.file(uri)) return;
      const indexed = await builder.indexAndStore(filePath, connection, () => !this.disposed);
      this.throwIfDisposed();
      this.retainCompatibleSourceFailure(
        builder,
        uri,
        indexed,
        previous,
        compatiblePrevious,
      );
    });

    await mapWithConcurrency(packages.packageRoots(), INDEX_CONCURRENCY, async (root) => {
      const files = await walkFiles(
        root,
        ['**/Documentation~/**', '**/Samples~/**'],
        this.abortController.signal,
      );
      await mapWithConcurrency(files, INDEX_CONCURRENCY, async (filePath) => {
        this.throwIfDisposed();
        const uri = pathToFileURL(filePath).href;
        if (builder.file(uri)) return;
        const indexed = await builder.indexAndStore(filePath, connection, () => !this.disposed);
        this.throwIfDisposed();
        this.retainCompatibleSourceFailure(
          builder,
          uri,
          indexed,
          previous,
          compatiblePrevious,
        );
      });
    });
  }

  async fullScan(
    connection: Connection,
    builder: IndexedRevisionBuilder,
    unityRoot: string,
    packages: PackageContext,
    settings: ExtensionSettings,
    previous: PublishedIndexedRevision | undefined,
    compatiblePrevious: boolean,
  ): Promise<number> {
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'indexing user files...', false);
    const before = builder.warningCount;
    try {
      const userFiles = await walkFiles(
        unityRoot,
        [...settings.excludePatterns, 'Packages/**'],
        this.abortController.signal,
      );
      let done = 0;
      await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (filePath) => {
        this.throwIfDisposed();
        const uri = pathToFileURL(filePath).href;
        const indexed = await builder.indexAndStore(filePath, connection, () => !this.disposed);
        this.throwIfDisposed();
        this.retainCompatibleSourceFailure(
          builder,
          uri,
          indexed,
          previous,
          compatiblePrevious,
        );
        done++;
        if (done % 25 === 0) progress.report(`${done}/${userFiles.length} files`);
      });

      progress.report('indexing Packages...');
      await mapWithConcurrency(packages.packageRoots(), INDEX_CONCURRENCY, async (root) => {
        const files = await walkFiles(
          root,
          ['**/Documentation~/**', '**/Samples~/**'],
          this.abortController.signal,
        );
        await mapWithConcurrency(files, INDEX_CONCURRENCY, async (filePath) => {
          this.throwIfDisposed();
          const uri = pathToFileURL(filePath).href;
          const indexed = await builder.indexAndStore(filePath, connection, () => !this.disposed);
          this.throwIfDisposed();
          this.retainCompatibleSourceFailure(
            builder,
            uri,
            indexed,
            previous,
            compatiblePrevious,
          );
        });
      });
      return builder.warningCount - before;
    } finally {
      progress.done();
    }
  }

  private retainCompatibleSourceFailure(
    builder: IndexedRevisionBuilder,
    uri: string,
    indexed: boolean,
    previous: PublishedIndexedRevision | undefined,
    compatiblePrevious: boolean,
  ): void {
    if (indexed) return;
    const previousRecord = previous?.diskRecord(uri);
    if (!previousRecord) return;
    if (!compatiblePrevious) {
      throw new IndexInfrastructureError(
        'indexing',
        `Cannot retain unreadable source across incompatible index semantics: ${uri}`,
      );
    }
    builder.restoreFromCache(uri, previousRecord.index, previousRecord.source);
    builder.recordSourceResult(uri, false);
  }

  private isCompatiblePrevious(
    previous: PublishedIndexedRevision | undefined,
    unityRoot: string | undefined,
    packages: PackageContext,
    fingerprint: CacheFingerprint | undefined,
  ): boolean {
    if (!previous || !previous.fingerprint || !fingerprint) return false;
    if (previous.unityRoot !== unityRoot) return false;
    if (JSON.stringify(previous.fingerprint) !== JSON.stringify(fingerprint)) return false;
    return JSON.stringify([...previous.packages.packageRoots()].sort())
      === JSON.stringify([...packages.packageRoots()].sort());
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

  private throwIfDisposed(): void {
    if (this.disposed) throw new WorkspaceDisposedError(this.folderUri);
  }
}

async function fileExists(uri: string): Promise<boolean> {
  try {
    await fs.stat(fileURLToPath(uri));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

class WorkspaceDisposedError extends Error {
  constructor(folderUri: string) {
    super(`Workspace was removed while indexing: ${folderUri}`);
    this.name = 'WorkspaceDisposedError';
  }
}
