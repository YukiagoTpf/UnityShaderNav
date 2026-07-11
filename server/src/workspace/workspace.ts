import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Connection,
  Location,
  LocationLink,
} from 'vscode-languageserver/node';
import {
  settingsRequireReindex,
  type CachedFile,
  type CacheFingerprint,
  type CacheManifest,
  type ExtensionSettings,
  type WorkspaceIndexStatus,
} from '@unity-shader-nav/shared';
import { CacheManager } from '../cache';
import { buildFingerprint } from '../cache/fingerprint';
import { INDEX_IMPLEMENTATION_IDENTITY } from '../cache/implementationIdentity';
import { PackageContext } from '../packages';
import { MacroPatternTable } from '../macros';
import { ensureParserReady } from '../parser/hlsl';
import { uriKey } from '../uriKey';
import {
  WorkspaceIndex,
  type DocumentIndexer,
  type FileEvent,
} from './workspaceIndex';
import type {
  DefinitionAtInput,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  OpenDocumentsProvider,
  ReferencesAtInput,
} from './indexedWorkspace';
import {
  canNavigateDefinitionWithoutDocumentIndex,
  navigateDefinition,
  navigateReferences,
  type WorkspaceNavigationState,
} from './navigation';
import { detectUnityRoot } from './detectUnityRoot';
import { containsPath } from './pathUtils';
import { mapWithConcurrency } from './concurrency';
import { IndexInfrastructureError, IndexLifecycle } from './indexLifecycle';
import { isIndexableFilePath, walkFiles } from './walkFiles';

export type { FileEvent } from './workspaceIndex';

const INDEX_CONCURRENCY = 8;
const CACHE_IO_CONCURRENCY = 32;

export interface WorkspaceRuntimeOptions {
  indexImplementation?: string | null;
  onIndexStatusChanged?: () => void;
  ensureParserReady?: () => Promise<void>;
  indexDocument?: DocumentIndexer;
  openDocuments?: OpenDocumentsProvider;
}

type DesiredDocumentState =
  | { readonly kind: 'open'; readonly document: IndexedDocumentSnapshot }
  | { readonly kind: 'closed'; readonly uri: string; readonly openId: number };

interface CommittedDocumentAttempt {
  readonly openId: number;
  readonly version: number;
  readonly indexEpoch: number;
}

interface DocumentReconcileRun {
  promise: Promise<void>;
}

export class Workspace implements IndexedWorkspace {
  readonly folderUri: string;
  unityRoot: string | undefined;
  packages: PackageContext;
  readonly index: WorkspaceIndex;
  private cache: CacheManager | undefined;
  private fingerprint: CacheFingerprint | undefined;
  private globalStorageDir: string | undefined;
  private _settings: ExtensionSettings;
  private readonly indexImplementation: string | null;
  private readonly lifecycle: IndexLifecycle;
  private readonly parserReady: () => Promise<void>;
  private readonly openDocuments: OpenDocumentsProvider | undefined;
  private statusMode: WorkspaceIndexStatus['mode'];
  private operationTail: Promise<void> = Promise.resolve();
  private pendingMutations = 0;
  private indexEpoch = 0;
  private readonly desiredDocuments = new Map<string, DesiredDocumentState>();
  private readonly committedDocuments = new Map<string, CommittedDocumentAttempt>();
  private readonly documentReconciles = new Map<string, DocumentReconcileRun>();
  private readonly abortController = new AbortController();
  private disposed = false;

  constructor(
    folderUri: string,
    settings: ExtensionSettings,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.folderUri = folderUri;
    this._settings = settings;
    this.indexImplementation = options.indexImplementation === undefined
      ? INDEX_IMPLEMENTATION_IDENTITY ?? null
      : options.indexImplementation;
    this.lifecycle = new IndexLifecycle(options.onIndexStatusChanged);
    this.parserReady = options.ensureParserReady ?? ensureParserReady;
    this.openDocuments = options.openDocuments;
    this.statusMode = settings.projectRoot.trim() ? 'unity' : 'standalone';
    this.index = new WorkspaceIndex(
      new MacroPatternTable(settings.declarationMacros),
      () => this.isStandalone(),
      options.indexDocument,
    );
    this.packages = PackageContext.standalone(settings);
  }

  get settings(): ExtensionSettings {
    return this._settings;
  }

  isStandalone(): boolean {
    return this.unityRoot === undefined;
  }

  containsIndexedUri(uri: string): boolean {
    try {
      const filePath = fileURLToPath(uri);
      if (this.index.hasDiskIndex(uri)) return true;

      const folderPath = fileURLToPath(this.folderUri);
      if (!this.unityRoot) {
        return isIndexableFilePath(folderPath, filePath, this.settings.excludePatterns);
      }

      const packageRoot = this.packages.packageRoots()
        .find((root) => containsPath(root, filePath));
      if (packageRoot) {
        return isIndexableFilePath(
          packageRoot,
          filePath,
          ['**/Documentation~/**', '**/Samples~/**'],
        );
      }

      if (isIndexableFilePath(
        this.unityRoot,
        filePath,
        [...this.settings.excludePatterns, 'Packages/**'],
      )) return true;

      return false;
    } catch {
      return false;
    }
  }

  indexStatus(): WorkspaceIndexStatus {
    return {
      folderUri: this.folderUri,
      mode: this.statusMode,
      lifecycle: this.lifecycle.snapshot(),
    };
  }

  canServe(): boolean {
    return !this.disposed && this.lifecycle.canServe();
  }

  updateDocument(document: IndexedDocumentSnapshot): Promise<boolean> {
    if (this.disposed || !this.acceptDocument(document)) return Promise.resolve(false);
    if (this.isDocumentCommitted(document, this.indexEpoch)) return Promise.resolve(true);

    return this.reconcileDocumentAttempt(document);
  }

  closeDocument(input: { readonly uri: string; readonly openId: number }): Promise<void> {
    if (this.disposed || !this.acceptDocumentClose(input.uri, input.openId)) {
      return Promise.resolve();
    }
    return this.reconcileDocumentClose(input.uri, input.openId);
  }

  private async reconcileDocumentAttempt(document: IndexedDocumentSnapshot): Promise<boolean> {
    while (this.isCurrentDocument(document, this.indexEpoch)) {
      if (this.isDocumentCommitted(document, this.indexEpoch)) return true;
      await this.ensureDocumentReconcile(document.uri);
      if (!this.lifecycle.canServe()) return false;
    }
    return false;
  }

  private async reconcileDocumentClose(uri: string, openId: number): Promise<void> {
    const key = uriKey(uri);
    while (true) {
      const desired = this.desiredDocuments.get(key);
      if (desired?.kind !== 'closed' || desired.openId !== openId) return;
      await this.ensureDocumentReconcile(uri);
      if (!this.lifecycle.canServe()) return;
    }
  }

  definitionAt(input: DefinitionAtInput): Promise<LocationLink[] | Location[] | null> {
    if (canNavigateDefinitionWithoutDocumentIndex(input)) {
      if (!this.canServe()) return Promise.resolve(null);
      return this.enqueueOperation(async () => {
        if (!this.canServe()) return null;
        const result = await navigateDefinition(this.navigationState(), input);
        return this.canServe() ? result : null;
      });
    }

    // updateDocument synchronously records/queues the caller's attempt. The
    // reconcile run releases its URI slot atomically with its final desired-
    // state check, so this query can safely retain its position ahead of later
    // operations while it awaits that attempt.
    const documentReady = this.updateDocument(input.document);
    return this.enqueueOperation(async () => {
      try {
        if (!await documentReady || !this.canServe()) return null;
      } catch {
        return null;
      }
      const epoch = this.indexEpoch;
      const result = await navigateDefinition(this.navigationState(), input);
      return this.isDocumentCommitted(input.document, epoch) ? result : null;
    });
  }

  referencesAt(input: ReferencesAtInput): Promise<Location[] | null> {
    const documentReady = this.updateDocument(input.document);
    return this.enqueueOperation(async () => {
      try {
        if (!await documentReady || !this.canServe()) return null;
      } catch {
        return null;
      }
      const epoch = this.indexEpoch;
      const result = await navigateReferences(this.navigationState(), input);
      return this.isDocumentCommitted(input.document, epoch) ? result : null;
    });
  }

  private navigationState(): WorkspaceNavigationState {
    const packages = this.packages;
    const settings = this.settings;
    return {
      index: this.index,
      includeCtx: packages.includeCtx,
      isInPackages: (uri) => packages.isInPackages(uri),
      includePackages: settings.findReferences.includePackages,
      definitionTrace: settings.debug.definitionTrace,
    };
  }

  private acceptDocument(document: IndexedDocumentSnapshot): boolean {
    const key = uriKey(document.uri);
    const current = this.desiredDocuments.get(key);
    if (current?.kind === 'open') {
      const previous = current.document;
      if (document.openId < previous.openId) return false;
      if (document.openId === previous.openId) {
        if (document.version < previous.version) return false;
        if (document.version === previous.version) {
          return document.languageId === previous.languageId && document.text === previous.text;
        }
      }
    } else if (current?.kind === 'closed' && document.openId <= current.openId) {
      return false;
    }

    this.desiredDocuments.set(key, { kind: 'open', document });
    return true;
  }

  private acceptDocumentClose(uri: string, openId: number): boolean {
    const key = uriKey(uri);
    const current = this.desiredDocuments.get(key);
    if (current?.kind !== 'open' || openId !== current.document.openId) return false;

    this.desiredDocuments.set(key, { kind: 'closed', uri, openId });
    return true;
  }

  private ensureDocumentReconcile(uri: string): Promise<void> {
    const key = uriKey(uri);
    const existing = this.documentReconciles.get(key);
    if (existing) return existing.promise;

    const run: DocumentReconcileRun = { promise: Promise.resolve() };
    this.documentReconciles.set(key, run);
    const release = (): void => {
      if (this.documentReconciles.get(key) === run) {
        this.documentReconciles.delete(key);
      }
    };
    run.promise = this.enqueueMutation(() => {
      if (this.disposed || !this.lifecycle.canServe()) {
        release();
        return Promise.resolve();
      }
      return this.performDocumentReconcile(key, false, release).catch((error: unknown) => {
        if (!this.disposed && this.lifecycle.snapshot().state === 'ready') {
          this.lifecycle.fail(error);
        }
        throw error;
      });
    });
    return run.promise;
  }

  private async performDocumentReconcile(
    key: string,
    allowBeforePublish = false,
    releaseRun?: () => void,
  ): Promise<void> {
    try {
      if (!allowBeforePublish && !this.lifecycle.canServe()) return;

      while (!this.disposed && this.documentNeedsReconcile(key)) {
        const desired = this.desiredDocuments.get(key);
        if (!desired) return;
        const epoch = this.indexEpoch;

        if (desired.kind === 'closed') {
          const isCurrent = (): boolean => this.isCurrentClose(desired, epoch);
          try {
            const restored = await this.index.restoreClosedDocument(desired.uri, isCurrent);
            if (restored && isCurrent()) {
              this.committedDocuments.delete(key);
              this.desiredDocuments.delete(key);
            }
          } catch (error) {
            if (!isCurrent()) continue;
            throw error;
          }
          continue;
        }

        const document = desired.document;
        const isCurrent = (): boolean => this.isCurrentDocument(document, epoch);
        try {
          const candidate = await this.index.prepareDocument(
            document.uri,
            document.text,
            isCurrent,
          );
          if (!candidate) continue;
          if (this.index.commitDocument(candidate, isCurrent)) {
            this.committedDocuments.set(key, {
              openId: document.openId,
              version: document.version,
              indexEpoch: epoch,
            });
          }
        } catch (error) {
          if (!isCurrent()) continue;
          throw error;
        }
      }
    } finally {
      // The final documentNeedsReconcile check and URI-slot release happen in
      // one JavaScript turn. An attempt accepted before release is consumed by
      // this run; one accepted after release creates its successor before a
      // caller can enqueue the dependent query.
      releaseRun?.();
    }
  }

  private documentNeedsReconcile(uri: string): boolean {
    const key = uriKey(uri);
    const desired = this.desiredDocuments.get(key);
    if (!desired) return false;
    return desired.kind === 'open'
      ? !this.isDocumentCommitted(desired.document, this.indexEpoch)
      : true;
  }

  private isCurrentDocument(document: IndexedDocumentSnapshot, epoch: number): boolean {
    if (this.disposed || this.indexEpoch !== epoch) return false;
    const desired = this.desiredDocuments.get(uriKey(document.uri));
    return desired?.kind === 'open'
      && desired.document.openId === document.openId
      && desired.document.version === document.version
      && desired.document.text === document.text
      && desired.document.languageId === document.languageId;
  }

  private isCurrentClose(
    close: Extract<DesiredDocumentState, { kind: 'closed' }>,
    epoch: number,
  ): boolean {
    if (this.disposed || this.indexEpoch !== epoch) return false;
    const desired = this.desiredDocuments.get(uriKey(close.uri));
    return desired?.kind === 'closed' && desired.openId === close.openId;
  }

  private isDocumentCommitted(document: IndexedDocumentSnapshot, epoch: number): boolean {
    const committed = this.committedDocuments.get(uriKey(document.uri));
    return this.isCurrentDocument(document, epoch)
      && committed?.openId === document.openId
      && committed.version === document.version
      && committed.indexEpoch === epoch;
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
      });
    }
  }

  private containsDocument(uri: string): boolean {
    try {
      return containsPath(fileURLToPath(this.folderUri), fileURLToPath(uri));
    } catch {
      return false;
    }
  }

  private async reconcileOpenDocumentsBeforePublish(): Promise<void> {
    while (!this.disposed) {
      this.captureOpenDocuments(true);
      const uris = [...this.desiredDocuments.keys()]
        .filter((uri) => this.documentNeedsReconcile(uri));
      if (uris.length === 0) return;
      for (const uri of uris) {
        await this.performDocumentReconcile(uri, true);
      }
    }
  }

  /** Reconcile live-document ownership after workspace routing topology changes. */
  synchronizeOpenDocuments(): Promise<void> {
    // An initial/rebuilding Workspace is already non-serving and will capture
    // the provider before its next ready publication. Do not queue behind a
    // bootstrap that may be intentionally long-running.
    if (!this.canServe()) return Promise.resolve();
    return this.enqueueMutation(async () => {
      if (this.disposed || !this.lifecycle.canServe()) return;
      try {
        while (!this.disposed && this.lifecycle.canServe()) {
          this.captureOpenDocuments(true);
          const uris = [...this.desiredDocuments.keys()]
            .filter((uri) => this.documentNeedsReconcile(uri));
          if (uris.length === 0) return;
          for (const uri of uris) await this.performDocumentReconcile(uri);
        }
      } catch (error) {
        if (!this.disposed) this.lifecycle.fail(error);
        throw error;
      }
    });
  }

  /**
   * Retire this workspace instance synchronously. In-flight I/O is allowed to
   * drain, but it may no longer publish index or cache state after removal.
   */
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
    try {
      if (this.disposed) return;
      const warningCount = await this.bootstrap(connection, globalStorageDir);
      if (this.disposed) return;
      await this.reconcileOpenDocumentsBeforePublish();
      if (this.disposed) return;
      this.statusMode = this.isStandalone() ? 'standalone' : 'unity';
      this.lifecycle.complete(warningCount);
    } catch (error) {
      if (this.disposed) return;
      this.statusMode = this.isStandalone() ? 'standalone' : 'unity';
      this.lifecycle.fail(error);
      throw error;
    }
  }

  /**
   * Decide whether settings require a rebuild inside the workspace operation
   * queue. Comparing at execution time keeps queued S0 -> S1 -> S0 updates
   * consistent with the index revision they produce.
   */
  reconfigure(connection: Connection, settings: ExtensionSettings): Promise<boolean> {
    return this.enqueueMutation(async () => {
      if (this.disposed) return false;
      if (!settingsRequireReindex(this._settings, settings)) {
        this.applySettingsNow(settings);
        return false;
      }
      await this.performRebuild(connection, settings);
      return !this.disposed;
    });
  }

  private applySettingsNow(settings: ExtensionSettings): void {
    // Settings and the compiled declaration-macro table are one invariant;
    // production callers can reach this mutation only through reconfigure or
    // rebuild inside the workspace operation queue.
    this._settings = settings;
    this.index.rebuildTable(settings.declarationMacros);
  }

  applyChanges(events: FileEvent[], connection: Connection): Promise<void> {
    return this.enqueueMutation(() => this.performApplyChanges(events, connection));
  }

  private async performApplyChanges(events: FileEvent[], connection: Connection): Promise<void> {
    if (this.disposed || !this.lifecycle.canApplyIncrementalChanges()) return;
    try {
      await this.index.applyChanges(events, connection, () => !this.disposed);
      if (this.disposed) return;
      // Watchers update the disk baseline. An accepted live document remains
      // authoritative, so invalidate and republish its overlay before the
      // mutation becomes observable or persistent work continues.
      for (const { uri } of events) {
        const key = uriKey(uri);
        const desired = this.desiredDocuments.get(key);
        if (desired?.kind !== 'open') continue;
        this.committedDocuments.delete(key);
        await this.performDocumentReconcile(key);
      }
      if (this.disposed) return;
      await this.persistNow();
    } catch (error) {
      if (this.disposed) return;
      this.lifecycle.fail(error);
      throw error;
    }
  }

  async bootstrap(connection: Connection, _globalStorageDir?: string): Promise<number> {
    this.throwIfDisposed();
    this.globalStorageDir = _globalStorageDir;
    const folderPath = fileURLToPath(this.folderUri);
    const configuredRoot = this.settings.projectRoot.trim();
    this.unityRoot = configuredRoot || (await detectUnityRoot(folderPath)) || undefined;
    this.throwIfDisposed();

    if (!this.unityRoot) {
      this.packages = PackageContext.standalone(this.settings);
      await this.preflightParser();
      await this.configureCache(folderPath, _globalStorageDir, connection);
      const manifest = await this.cache?.load(this.fingerprint);
      this.throwIfDisposed();
      if (manifest && this.matchesWorkspace(manifest)) {
        return this.bootstrapFromCache(connection, manifest);
      }
      return 0;
    }

    try {
      this.packages = await PackageContext.load(this.unityRoot, this.settings);
      this.throwIfDisposed();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new IndexInfrastructureError('package-resolution', message, { cause: error });
    }
    await this.preflightParser();

    await this.configureCache(folderPath, _globalStorageDir, connection);
    const manifest = await this.cache?.load(this.fingerprint);
    this.throwIfDisposed();
    if (manifest && this.matchesWorkspace(manifest)) {
      return this.bootstrapFromCache(connection, manifest);
    }

    const warningCount = await this.fullScan(connection);
    await this.persistNow();
    return warningCount;
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
    globalStorageDir: string | undefined,
    connection: Connection,
  ): Promise<void> {
    this.cache = CacheManager.create({
      unityProjectRoot: this.unityRoot,
      workspaceFolderUri: this.folderUri,
      globalStorageDir,
    });
    if (!this.cache) {
      this.fingerprint = undefined;
      return;
    }

    this.fingerprint = await buildFingerprint(
      this.settings,
      this.resolveWasmPath(folderPath),
      this.indexImplementation ?? undefined,
    );
    this.throwIfDisposed();
    if (!this.fingerprint) {
      connection.console.warn(
        'Index cache disabled: the running index implementation could not be identified.',
      );
      this.cache = undefined;
    }
  }

  private resolveWasmPath(folderPath: string): string {
    const candidates = [
      join(__dirname, '..', '..', 'grammars', 'tree-sitter-hlsl.wasm'),
      join(__dirname, '..', 'grammars', 'tree-sitter-hlsl.wasm'),
      join(folderPath, 'server', 'grammars', 'tree-sitter-hlsl.wasm'),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }

  private matchesWorkspace(manifest: CacheManifest): boolean {
    return manifest.workspaceFolderUri === this.folderUri
      && manifest.unityProjectRoot === (this.unityRoot ?? null);
  }

  private async bootstrapFromCache(
    connection: Connection,
    manifest: CacheManifest | undefined,
  ): Promise<number> {
    if (!manifest || !this.cache) return 0;

    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'restoring cache...', false);
    const refreshQueue: string[] = [];
    let warningCount = 0;

    try {
      const restoreResults = await mapWithConcurrency(
        manifest.files,
        CACHE_IO_CONCURRENCY,
        async (cachedFile) => {
          this.throwIfDisposed();
          const valid = this.shouldRestoreCachedFile(cachedFile.uri)
            && await this.cache!.isValid(cachedFile);
          this.throwIfDisposed();
          return { cachedFile, valid };
        },
      );

      for (const { cachedFile, valid } of restoreResults) {
        this.throwIfDisposed();
        if (!this.shouldRestoreCachedFile(cachedFile.uri)) continue;

        if (valid) {
          this.index.restoreFromCache(cachedFile.uri, cachedFile.index);
        } else {
          refreshQueue.push(cachedFile.uri);
        }
      }

      progress.report(`re-parsing ${refreshQueue.length} changed files...`);
      const refreshResults = await mapWithConcurrency(
        refreshQueue,
        INDEX_CONCURRENCY,
        async (uri) => {
          this.throwIfDisposed();
          const filePath = fileURLToPath(uri);
          const indexed = await this.index.indexAndStore(
            filePath,
            connection,
            () => !this.disposed,
          );
          this.throwIfDisposed();
          if (!indexed) this.index.drop(uri);
          return indexed;
        },
      );
      const refreshWarnings = refreshResults.filter((indexed) => !indexed).length;
      const missingWarnings = await this.indexMissingDiskFiles(connection);
      warningCount = refreshWarnings + missingWarnings;
    } finally {
      progress.done();
    }

    await this.persistNow();
    return warningCount;
  }

  private shouldRestoreCachedFile(uri: string): boolean {
    // packages resolver is present iff unityRoot is set (see bootstrap); checking unityRoot suffices.
    if (!this.unityRoot) return true;

    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return false;
    }

    const currentPackageRoots = this.packages.packageRoots();
    if (currentPackageRoots.some((root) => containsPath(root, filePath))) {
      return true;
    }

    const packageAreas = [
      join(this.unityRoot, 'Packages'),
      join(this.unityRoot, 'Library', 'PackageCache'),
    ];
    return !packageAreas.some((root) => containsPath(root, filePath));
  }

  private async indexMissingDiskFiles(connection: Connection): Promise<number> {
    if (!this.unityRoot) return 0;

    const userFiles = await walkFiles(
      this.unityRoot,
      [...this.settings.excludePatterns, 'Packages/**'],
      this.abortController.signal,
    );
    const userResults = await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (filePath) => {
      this.throwIfDisposed();
      const uri = pathToFileURL(filePath).href;
      const indexed = this.index.store.get(uri)
        ? true
        : await this.index.indexAndStore(filePath, connection, () => !this.disposed);
      this.throwIfDisposed();
      return indexed;
    });
    let warningCount = userResults.filter((indexed) => !indexed).length;

    if (!this.packages.hasResolver()) return warningCount;
    const packageWarningCounts = await mapWithConcurrency(
      this.packages.packageRoots(),
      INDEX_CONCURRENCY,
      async (path) => {
        const packageFiles = await walkFiles(
          path,
          ['**/Documentation~/**', '**/Samples~/**'],
          this.abortController.signal,
        );
        const results = await mapWithConcurrency(
          packageFiles,
          INDEX_CONCURRENCY,
          async (filePath) => {
            this.throwIfDisposed();
            const uri = pathToFileURL(filePath).href;
            const indexed = this.index.store.get(uri)
              ? true
              : await this.index.indexAndStore(
                filePath,
                connection,
                () => !this.disposed,
              );
            this.throwIfDisposed();
            return indexed;
          },
        );
        return results.filter((indexed) => !indexed).length;
      },
    );
    warningCount += packageWarningCounts.reduce((sum, count) => sum + count, 0);
    return warningCount;
  }

  async fullScan(connection: Connection): Promise<number> {
    if (!this.unityRoot) return 0;

    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'indexing user files...', false);

    try {
      const userFiles = await walkFiles(
        this.unityRoot,
        [...this.settings.excludePatterns, 'Packages/**'],
        this.abortController.signal,
      );
      let done = 0;
      const userResults = await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (file) => {
        this.throwIfDisposed();
        const indexed = await this.index.indexAndStore(file, connection, () => !this.disposed);
        this.throwIfDisposed();
        done++;
        if (done % 25 === 0) progress.report(`${done}/${userFiles.length} files`);
        return indexed;
      });
      let warningCount = userResults.filter((indexed) => !indexed).length;

      if (!this.packages.hasResolver()) return warningCount;

      progress.report('indexing Packages...');
      const packageWarningCounts = await mapWithConcurrency(
        this.packages.packageRoots(),
        INDEX_CONCURRENCY,
        async (path) => {
          const packageFiles = await walkFiles(
            path,
            ['**/Documentation~/**', '**/Samples~/**'],
            this.abortController.signal,
          );
          const results = await mapWithConcurrency(
            packageFiles,
            INDEX_CONCURRENCY,
            async (file) => {
              this.throwIfDisposed();
              const indexed = await this.index.indexAndStore(
                file,
                connection,
                () => !this.disposed,
              );
              this.throwIfDisposed();
              return indexed;
            },
          );
          return results.filter((indexed) => !indexed).length;
        },
      );
      warningCount += packageWarningCounts.reduce((sum, count) => sum + count, 0);
      return warningCount;
    } finally {
      progress.done();
    }
  }

  rebuild(connection: Connection, settings?: ExtensionSettings): Promise<void> {
    return this.enqueueMutation(() => this.performRebuild(connection, settings));
  }

  private async performRebuild(
    connection: Connection,
    settings?: ExtensionSettings,
  ): Promise<void> {
    if (this.disposed) return;
    this.lifecycle.begin(this.lifecycle.nextRebuildOperation());
    try {
      if (settings) this.applySettingsNow(settings);
      this.indexEpoch++;
      this.committedDocuments.clear();
      this.index.clear();
      const warningCount = await this.bootstrap(connection, this.globalStorageDir);
      if (this.disposed) return;
      await this.reconcileOpenDocumentsBeforePublish();
      if (this.disposed) return;
      this.statusMode = this.isStandalone() ? 'standalone' : 'unity';
      this.lifecycle.complete(warningCount);
    } catch (error) {
      if (this.disposed) return;
      this.statusMode = this.isStandalone() ? 'standalone' : 'unity';
      this.lifecycle.fail(error);
      throw error;
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingMutations++;
    return this.enqueueOperation(async () => {
      try {
        return await operation();
      } finally {
        this.pendingMutations--;
      }
    });
  }

  persist(): Promise<void> {
    // Persistence is derived, best-effort work. It must never wait behind a
    // blocked mutation or snapshot a failed/partially rebuilt index.
    if (this.pendingMutations > 0 || !this.canServe()) return Promise.resolve();
    return this.enqueueOperation(() => this.persistNow(true));
  }

  private async persistNow(requireServing = false): Promise<void> {
    if (
      this.disposed
      || (requireServing && !this.canServe())
      || !this.cache
      || !this.fingerprint
    ) return;
    const cache = this.cache;
    const fingerprint = this.fingerprint;

    const snapshots = await mapWithConcurrency(
      this.index.diskIndexEntries(),
      CACHE_IO_CONCURRENCY,
      async ([uri, index]) => this.disposed ? null : cache.snapshot(uri, index),
    );
    if (this.disposed || (requireServing && !this.canServe())) return;
    const records: CachedFile[] = snapshots
      .filter((snapshot): snapshot is CachedFile => snapshot !== null)
      .sort((a, b) => a.uri.localeCompare(b.uri));

    const manifest = cache.buildManifest(
      this.folderUri,
      this.unityRoot ?? null,
      fingerprint,
      records,
    );
    try {
      // The activity check and save queue registration are synchronous with
      // respect to the JavaScript event loop. A retired writer either queues
      // before its replacement (which then wins) or does not queue at all.
      await (this.disposed ? Promise.resolve() : cache.save(manifest));
    } catch {
      // Cache persistence is best-effort; indexing results remain usable without it.
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new WorkspaceDisposedError(this.folderUri);
  }
}

class WorkspaceDisposedError extends Error {
  constructor(folderUri: string) {
    super(`Workspace was removed while indexing: ${folderUri}`);
    this.name = 'WorkspaceDisposedError';
  }
}
