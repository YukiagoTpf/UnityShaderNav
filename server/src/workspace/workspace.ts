import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
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
import { WorkspaceIndex } from './workspaceIndex';
import type { FileEvent } from './workspaceIndex';
import { detectUnityRoot } from './detectUnityRoot';
import { containsPath } from './pathUtils';
import { mapWithConcurrency } from './concurrency';
import { IndexInfrastructureError, IndexLifecycle } from './indexLifecycle';
import { walkFiles } from './walkFiles';

export type { FileEvent } from './workspaceIndex';

const INDEX_CONCURRENCY = 8;
const CACHE_IO_CONCURRENCY = 32;

export interface WorkspaceRuntimeOptions {
  indexImplementation?: string | null;
  onIndexStatusChanged?: () => void;
  ensureParserReady?: () => Promise<void>;
}

export class Workspace {
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
  private statusMode: WorkspaceIndexStatus['mode'];
  private operationTail: Promise<void> = Promise.resolve();
  private pendingMutations = 0;
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
    this.statusMode = settings.projectRoot.trim() ? 'unity' : 'standalone';
    this.index = new WorkspaceIndex(
      new MacroPatternTable(settings.declarationMacros),
      () => this.isStandalone(),
    );
    this.packages = PackageContext.standalone(settings);
  }

  get settings(): ExtensionSettings {
    return this._settings;
  }

  isStandalone(): boolean {
    return this.unityRoot === undefined;
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
      this.index.clear();
      const warningCount = await this.bootstrap(connection, this.globalStorageDir);
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
