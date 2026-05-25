import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type {
  CachedFile,
  CacheFingerprint,
  CacheManifest,
  ExtensionSettings,
  FileIndex,
} from '@unity-shader-nav/shared';
import { CacheManager, CacheStore, chooseCacheDir } from '../cache';
import { buildFingerprint } from '../cache/fingerprint';
import { PackageResolver } from '../packages';
import type { IncludeContext } from '../include';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../index';
import { MacroPatternTable } from '../macros';
import { indexFile } from '../parser/hlsl';
import { detectUnityRoot } from './detectUnityRoot';
import { containsPath } from './pathUtils';
import { mapWithConcurrency } from './concurrency';
import { walkFiles } from './walkFiles';

export interface FileEvent {
  uri: string;
  type: 'created' | 'changed' | 'deleted';
}

const INDEX_CONCURRENCY = 8;
const CACHE_IO_CONCURRENCY = 32;

export class Workspace {
  readonly folderUri: string;
  unityRoot: string | undefined;
  packageResolver: PackageResolver | undefined;
  includeCtx: IncludeContext;
  readonly store = new IndexStore();
  readonly global = new GlobalSymbolIndex();
  readonly globalRefs = new GlobalReferenceIndex();
  private readonly diskIndexes = new Map<string, FileIndex>();
  private cache: CacheManager | undefined;
  private fingerprint: CacheFingerprint | undefined;
  private globalStorageDir: string | undefined;
  table: MacroPatternTable;
  settings: ExtensionSettings;

  constructor(folderUri: string, settings: ExtensionSettings) {
    this.folderUri = folderUri;
    this.settings = settings;
    this.table = new MacroPatternTable(settings.declarationMacros);
    this.includeCtx = {
      unityProjectRoot: undefined,
      includeDirectories: settings.includeDirectories,
    };
  }

  isStandalone(): boolean {
    return this.unityRoot === undefined;
  }

  async bootstrap(connection: Connection, _globalStorageDir?: string): Promise<void> {
    this.globalStorageDir = _globalStorageDir;
    const folderPath = fileURLToPath(this.folderUri);
    const configuredRoot = this.settings.projectRoot.trim();
    this.unityRoot = configuredRoot || (await detectUnityRoot(folderPath)) || undefined;

    if (!this.unityRoot) {
      this.packageResolver = undefined;
      this.includeCtx = {
        unityProjectRoot: undefined,
        includeDirectories: this.settings.includeDirectories,
      };
      await this.configureCache(folderPath, _globalStorageDir);
      const manifest = await this.cache?.load(this.fingerprint);
      if (manifest && this.matchesWorkspace(manifest)) {
        await this.bootstrapFromCache(connection, manifest);
      }
      return;
    }

    this.packageResolver = new PackageResolver(this.unityRoot);
    await this.packageResolver.load();
    this.includeCtx = {
      unityProjectRoot: this.unityRoot,
      includeDirectories: this.settings.includeDirectories,
      packagePhysicalPaths: this.packageResolver.asIncludeContextMap(),
    };

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
    const cacheDir = chooseCacheDir({
      unityProjectRoot: this.unityRoot,
      workspaceFolderUri: this.folderUri,
      globalStorageDir,
    });
    if (!cacheDir) {
      this.cache = undefined;
      this.fingerprint = undefined;
      return;
    }

    this.cache = new CacheManager(new CacheStore(cacheDir));
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
          this.diskIndexes.set(cachedFile.uri, cachedFile.index);
          this.store.set(cachedFile.uri, cachedFile.index);
          this.global.upsert(cachedFile.index);
          this.globalRefs.upsert(cachedFile.index);
        } else {
          refreshQueue.push(cachedFile.uri);
        }
      }

      progress.report(`re-parsing ${refreshQueue.length} changed files...`);
      await mapWithConcurrency(refreshQueue, INDEX_CONCURRENCY, async (uri) => {
        try {
          const filePath = fileURLToPath(uri);
          await this.indexAndStore(filePath, connection);
        } catch {
          this.drop(uri);
        }
      });

      await this.indexMissingDiskFiles(connection);
    } finally {
      progress.done();
    }

    await this.persist();
  }

  private shouldRestoreCachedFile(uri: string): boolean {
    if (!this.unityRoot || !this.packageResolver) return true;

    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return false;
    }

    const currentPackageRoots = this.packageResolver.allPaths().map(({ path }) => path);
    if (currentPackageRoots.some((root) => containsPath(root, filePath))) {
      return true;
    }

    const packageAreas = [
      join(this.unityRoot, 'Packages'),
      join(this.unityRoot, 'Library', 'PackageCache'),
    ];
    return !packageAreas.some((root) => containsPath(root, filePath));
  }

  isInPackages(uri: string): boolean {
    if (!this.packageResolver) return false;

    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return false;
    }

    return this.packageResolver
      .allPaths()
      .some(({ path }) => containsPath(path, filePath));
  }

  private async indexMissingDiskFiles(connection: Connection): Promise<void> {
    if (!this.unityRoot) return;

    const userFiles = await walkFiles(this.unityRoot, [
      ...this.settings.excludePatterns,
      'Packages/**',
    ]);
    await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (filePath) => {
      const uri = pathToFileURL(filePath).href;
      if (!this.store.get(uri)) await this.indexAndStore(filePath, connection);
    });

    if (!this.packageResolver) return;
    await mapWithConcurrency(this.packageResolver.allPaths(), INDEX_CONCURRENCY, async ({ path }) => {
      const packageFiles = await walkFiles(path, ['**/Documentation~/**', '**/Samples~/**']);
      await mapWithConcurrency(packageFiles, INDEX_CONCURRENCY, async (filePath) => {
        const uri = pathToFileURL(filePath).href;
        if (!this.store.get(uri)) await this.indexAndStore(filePath, connection);
      });
    });
  }

  private async indexAndStore(absPath: string, connection?: Connection): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    try {
      const text = await fs.readFile(absPath, 'utf8');
      const idx = await indexFile(uri, text, this.table);
      this.diskIndexes.set(uri, idx);
      this.store.set(uri, idx);
      this.global.upsert(idx);
      this.globalRefs.upsert(idx);
      connection?.console.log(`[index] ${uri} -> ${idx.symbols.length} symbols, ${idx.references.length} refs`);
    } catch {
      // Ignore unreadable or unparsable files during background indexing.
    }
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
        await this.indexAndStore(file, connection);
        done++;
        if (done % 25 === 0) progress.report(`${done}/${userFiles.length} files`);
      });

      if (!this.packageResolver) return;

      progress.report('indexing Packages...');
      await mapWithConcurrency(this.packageResolver.allPaths(), INDEX_CONCURRENCY, async ({ path }) => {
        const packageFiles = await walkFiles(path, ['**/Documentation~/**', '**/Samples~/**']);
        await mapWithConcurrency(packageFiles, INDEX_CONCURRENCY, async (file) => {
          await this.indexAndStore(file, connection);
        });
      });
    } finally {
      progress.done();
    }
  }

  async reindex(uri: string, text: string, shouldStore: () => boolean = () => true): Promise<void> {
    const idx = await indexFile(uri, text, this.table);
    if (!shouldStore()) return;
    if (this.isStandalone()) {
      await this.refreshStandaloneDiskIndex(uri, text, idx);
    }
    this.store.set(uri, idx);
    this.global.upsert(idx);
    this.globalRefs.upsert(idx);
  }

  private async refreshStandaloneDiskIndex(
    uri: string,
    liveText: string,
    liveIndex: FileIndex,
  ): Promise<void> {
    try {
      const diskText = await fs.readFile(fileURLToPath(uri), 'utf8');
      const diskIndex = diskText === liveText
        ? liveIndex
        : await indexFile(uri, diskText, this.table);
      this.diskIndexes.set(uri, diskIndex);
    } catch {
      this.diskIndexes.delete(uri);
    }
  }

  async applyChanges(events: FileEvent[], connection: Connection): Promise<void> {
    for (const event of events) {
      if (event.type === 'deleted') {
        this.drop(event.uri);
        continue;
      }

      try {
        const filePath = fileURLToPath(event.uri);
        await this.indexAndStore(filePath, connection);
      } catch {
        this.drop(event.uri);
      }
    }
    await this.persist();
  }

  async rebuild(connection: Connection): Promise<void> {
    this.store.clear();
    this.global.clear();
    this.globalRefs.clear();
    this.diskIndexes.clear();
    await this.bootstrap(connection, this.globalStorageDir);
  }

  async persist(): Promise<void> {
    if (!this.cache || !this.fingerprint) return;

    const snapshots = await mapWithConcurrency(
      Array.from(this.diskIndexes),
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

  closeDocument(uri: string): void {
    const diskIndex = this.diskIndexes.get(uri);
    if (diskIndex) {
      this.store.set(uri, diskIndex);
      this.global.upsert(diskIndex);
      this.globalRefs.upsert(diskIndex);
      return;
    }

    this.drop(uri);
  }

  drop(uri: string): void {
    this.diskIndexes.delete(uri);
    this.store.delete(uri);
    this.global.delete(uri);
    this.globalRefs.delete(uri);
  }
}
