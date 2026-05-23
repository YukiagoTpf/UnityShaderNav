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
import { GlobalSymbolIndex, IndexStore } from '../index';
import { MacroPatternTable } from '../macros';
import { indexFile } from '../parser/hlsl';
import { detectUnityRoot } from './detectUnityRoot';
import { walkFiles } from './walkFiles';

export interface FileEvent {
  uri: string;
  type: 'created' | 'changed' | 'deleted';
}

export class Workspace {
  readonly folderUri: string;
  unityRoot: string | undefined;
  packageResolver: PackageResolver | undefined;
  includeCtx: IncludeContext;
  readonly store = new IndexStore();
  readonly global = new GlobalSymbolIndex();
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
      await this.bootstrapFromCache(connection, undefined);
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
      for (const cachedFile of manifest.files) {
        if (await this.cache.isValid(cachedFile)) {
          this.diskIndexes.set(cachedFile.uri, cachedFile.index);
          this.store.set(cachedFile.uri, cachedFile.index);
          this.global.upsert(cachedFile.index);
        } else {
          refreshQueue.push(cachedFile.uri);
        }
      }

      progress.report(`re-parsing ${refreshQueue.length} changed files...`);
      for (const uri of refreshQueue) {
        try {
          const filePath = fileURLToPath(uri);
          await this.indexAndStore(filePath, connection);
        } catch {
          this.drop(uri);
        }
      }

      await this.indexMissingDiskFiles(connection);
    } finally {
      progress.done();
    }

    await this.persist();
  }

  private async indexMissingDiskFiles(connection: Connection): Promise<void> {
    if (!this.unityRoot) return;

    const userFiles = await walkFiles(this.unityRoot, [
      ...this.settings.excludePatterns,
      'Packages/**',
    ]);
    for (const filePath of userFiles) {
      const uri = pathToFileURL(filePath).href;
      if (!this.store.get(uri)) await this.indexAndStore(filePath, connection);
    }

    if (!this.packageResolver) return;
    for (const { path } of this.packageResolver.allPaths()) {
      const packageFiles = await walkFiles(path, ['**/Documentation~/**', '**/Samples~/**']);
      for (const filePath of packageFiles) {
        const uri = pathToFileURL(filePath).href;
        if (!this.store.get(uri)) await this.indexAndStore(filePath, connection);
      }
    }
  }

  private async indexAndStore(absPath: string, connection?: Connection): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    try {
      const text = await fs.readFile(absPath, 'utf8');
      const idx = await indexFile(uri, text, this.table);
      this.diskIndexes.set(uri, idx);
      this.store.set(uri, idx);
      this.global.upsert(idx);
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
      for (const file of userFiles) {
        await this.indexAndStore(file, connection);
        done++;
        if (done % 25 === 0) progress.report(`${done}/${userFiles.length} files`);
      }

      if (!this.packageResolver) return;

      progress.report('indexing Packages...');
      for (const { path } of this.packageResolver.allPaths()) {
        const packageFiles = await walkFiles(path, ['**/Documentation~/**', '**/Samples~/**']);
        for (const file of packageFiles) {
          await this.indexAndStore(file, connection);
        }
      }
    } finally {
      progress.done();
    }
  }

  async reindex(uri: string, text: string, shouldStore: () => boolean = () => true): Promise<void> {
    const idx = await indexFile(uri, text, this.table);
    if (!shouldStore()) return;
    this.store.set(uri, idx);
    this.global.upsert(idx);
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
    this.diskIndexes.clear();
    await this.bootstrap(connection, this.globalStorageDir);
  }

  async persist(): Promise<void> {
    if (!this.cache || !this.fingerprint) return;

    const records: CachedFile[] = [];
    for (const [uri, index] of this.diskIndexes) {
      const snapshot = await this.cache.snapshot(uri, index);
      if (snapshot) records.push(snapshot);
    }

    const manifest = this.cache.buildManifest(
      this.folderUri,
      this.unityRoot ?? null,
      this.fingerprint,
      records,
    );
    await this.cache.save(manifest);
  }

  closeDocument(uri: string): void {
    const diskIndex = this.diskIndexes.get(uri);
    if (diskIndex) {
      this.store.set(uri, diskIndex);
      this.global.upsert(diskIndex);
      return;
    }

    this.drop(uri);
  }

  drop(uri: string): void {
    this.diskIndexes.delete(uri);
    this.store.delete(uri);
    this.global.delete(uri);
  }
}
