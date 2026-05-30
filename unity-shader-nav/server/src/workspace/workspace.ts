import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type {
  CachedFile,
  CacheFingerprint,
  CacheManifest,
  ExtensionSettings,
} from '@unity-shader-nav/shared';
import { CacheManager } from '../cache';
import { buildFingerprint } from '../cache/fingerprint';
import { PackageContext } from '../packages';
import { MacroPatternTable } from '../macros';
import { WorkspaceIndex } from './workspaceIndex';
import type { FileEvent } from './workspaceIndex';
import { detectUnityRoot } from './detectUnityRoot';
import { containsPath } from './pathUtils';
import { mapWithConcurrency } from './concurrency';
import { walkFiles } from './walkFiles';

export type { FileEvent } from './workspaceIndex';

const INDEX_CONCURRENCY = 8;
const CACHE_IO_CONCURRENCY = 32;

export class Workspace {
  readonly folderUri: string;
  unityRoot: string | undefined;
  packages: PackageContext;
  readonly index: WorkspaceIndex;
  private cache: CacheManager | undefined;
  private fingerprint: CacheFingerprint | undefined;
  private globalStorageDir: string | undefined;
  settings: ExtensionSettings;

  constructor(folderUri: string, settings: ExtensionSettings) {
    this.folderUri = folderUri;
    this.settings = settings;
    this.index = new WorkspaceIndex(new MacroPatternTable(settings.declarationMacros));
    this.packages = PackageContext.standalone(settings);
  }

  isStandalone(): boolean {
    return this.unityRoot === undefined;
  }

  // Pass-throughs to the composed WorkspaceIndex (#31). Handlers/lifecycle/tests keep
  // using workspace.store / .global / .reindex / etc.; the real owner is this.index.
  get store() { return this.index.store; }
  get global() { return this.index.global; }
  get globalRefs() { return this.index.globalRefs; }
  get table(): MacroPatternTable { return this.index.table; }
  set table(table: MacroPatternTable) { this.index.table = table; }

  reindex(uri: string, text: string, shouldStore: () => boolean = () => true): Promise<void> {
    return this.index.reindex(uri, text, this.isStandalone(), shouldStore);
  }

  async applyChanges(events: FileEvent[], connection: Connection): Promise<void> {
    await this.index.applyChanges(events, connection);
    await this.persist();
  }

  closeDocument(uri: string): void {
    this.index.closeDocument(uri);
  }

  drop(uri: string): void {
    this.index.drop(uri);
  }

  async bootstrap(connection: Connection, _globalStorageDir?: string): Promise<void> {
    this.globalStorageDir = _globalStorageDir;
    const folderPath = fileURLToPath(this.folderUri);
    const configuredRoot = this.settings.projectRoot.trim();
    this.unityRoot = configuredRoot || (await detectUnityRoot(folderPath)) || undefined;

    if (!this.unityRoot) {
      this.packages = PackageContext.standalone(this.settings);
      await this.configureCache(folderPath, _globalStorageDir);
      const manifest = await this.cache?.load(this.fingerprint);
      if (manifest && this.matchesWorkspace(manifest)) {
        await this.bootstrapFromCache(connection, manifest);
      }
      return;
    }

    this.packages = await PackageContext.load(this.unityRoot, this.settings);

    await this.configureCache(folderPath, _globalStorageDir);
    const manifest = await this.cache?.load(this.fingerprint);
    if (manifest && this.matchesWorkspace(manifest)) {
      await this.bootstrapFromCache(connection, manifest);
      return;
    }

    await this.fullScan(connection);
    await this.persist();
  }

  private async configureCache(folderPath: string, globalStorageDir?: string): Promise<void> {
    this.cache = CacheManager.create({
      unityProjectRoot: this.unityRoot,
      workspaceFolderUri: this.folderUri,
      globalStorageDir,
    });
    if (!this.cache) {
      this.fingerprint = undefined;
      return;
    }

    this.fingerprint = await buildFingerprint(this.settings, this.resolveWasmPath(folderPath));
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
  ): Promise<void> {
    if (!manifest || !this.cache) return;

    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'restoring cache...', false);
    const refreshQueue: string[] = [];

    try {
      const restoreResults = await mapWithConcurrency(
        manifest.files,
        CACHE_IO_CONCURRENCY,
        async (cachedFile) => ({
          cachedFile,
          valid: this.shouldRestoreCachedFile(cachedFile.uri)
            && await this.cache!.isValid(cachedFile),
        }),
      );

      for (const { cachedFile, valid } of restoreResults) {
        if (!this.shouldRestoreCachedFile(cachedFile.uri)) continue;

        if (valid) {
          this.index.restoreFromCache(cachedFile.uri, cachedFile.index);
        } else {
          refreshQueue.push(cachedFile.uri);
        }
      }

      progress.report(`re-parsing ${refreshQueue.length} changed files...`);
      await mapWithConcurrency(refreshQueue, INDEX_CONCURRENCY, async (uri) => {
        try {
          const filePath = fileURLToPath(uri);
          await this.index.indexAndStore(filePath, connection);
        } catch {
          this.index.drop(uri);
        }
      });

      await this.indexMissingDiskFiles(connection);
    } finally {
      progress.done();
    }

    await this.persist();
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

  private async indexMissingDiskFiles(connection: Connection): Promise<void> {
    if (!this.unityRoot) return;

    const userFiles = await walkFiles(this.unityRoot, [
      ...this.settings.excludePatterns,
      'Packages/**',
    ]);
    await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (filePath) => {
      const uri = pathToFileURL(filePath).href;
      if (!this.index.store.get(uri)) await this.index.indexAndStore(filePath, connection);
    });

    if (!this.packages.hasResolver()) return;
    await mapWithConcurrency(this.packages.packageRoots(), INDEX_CONCURRENCY, async (path) => {
      const packageFiles = await walkFiles(path, ['**/Documentation~/**', '**/Samples~/**']);
      await mapWithConcurrency(packageFiles, INDEX_CONCURRENCY, async (filePath) => {
        const uri = pathToFileURL(filePath).href;
        if (!this.index.store.get(uri)) await this.index.indexAndStore(filePath, connection);
      });
    });
  }

  async fullScan(connection: Connection): Promise<void> {
    if (!this.unityRoot) return;

    const progress = await connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'indexing user files...', false);

    try {
      const userFiles = await walkFiles(this.unityRoot, [
        ...this.settings.excludePatterns,
        'Packages/**',
      ]);
      let done = 0;
      await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (file) => {
        await this.index.indexAndStore(file, connection);
        done++;
        if (done % 25 === 0) progress.report(`${done}/${userFiles.length} files`);
      });

      if (!this.packages.hasResolver()) return;

      progress.report('indexing Packages...');
      await mapWithConcurrency(this.packages.packageRoots(), INDEX_CONCURRENCY, async (path) => {
        const packageFiles = await walkFiles(path, ['**/Documentation~/**', '**/Samples~/**']);
        await mapWithConcurrency(packageFiles, INDEX_CONCURRENCY, async (file) => {
          await this.index.indexAndStore(file, connection);
        });
      });
    } finally {
      progress.done();
    }
  }

  async rebuild(connection: Connection): Promise<void> {
    this.index.clear();
    await this.bootstrap(connection, this.globalStorageDir);
  }

  async persist(): Promise<void> {
    if (!this.cache || !this.fingerprint) return;

    const snapshots = await mapWithConcurrency(
      this.index.diskIndexEntries(),
      CACHE_IO_CONCURRENCY,
      async ([uri, index]) => this.cache!.snapshot(uri, index),
    );
    const records: CachedFile[] = snapshots
      .filter((snapshot): snapshot is CachedFile => snapshot !== null)
      .sort((a, b) => a.uri.localeCompare(b.uri));

    const manifest = this.cache.buildManifest(
      this.folderUri,
      this.unityRoot ?? null,
      this.fingerprint,
      records,
    );
    try {
      await this.cache.save(manifest);
    } catch {
      // Cache persistence is best-effort; indexing results remain usable without it.
    }
  }
}
