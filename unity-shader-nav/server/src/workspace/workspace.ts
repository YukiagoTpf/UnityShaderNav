import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { PackageResolver } from '../packages';
import type { IncludeContext } from '../include';
import { GlobalSymbolIndex, IndexStore } from '../index';
import { MacroPatternTable } from '../macros';
import { indexFile } from '../parser/hlsl';
import { detectUnityRoot } from './detectUnityRoot';
import { walkFiles } from './walkFiles';

export class Workspace {
  readonly folderUri: string;
  unityRoot: string | undefined;
  packageResolver: PackageResolver | undefined;
  includeCtx: IncludeContext;
  readonly store = new IndexStore();
  readonly global = new GlobalSymbolIndex();
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
    const folderPath = fileURLToPath(this.folderUri);
    this.unityRoot = (await detectUnityRoot(folderPath)) ?? undefined;

    if (!this.unityRoot) {
      this.packageResolver = undefined;
      this.includeCtx = {
        unityProjectRoot: undefined,
        includeDirectories: this.settings.includeDirectories,
      };
      return;
    }

    this.packageResolver = new PackageResolver(this.unityRoot);
    await this.packageResolver.load();
    this.includeCtx = {
      unityProjectRoot: this.unityRoot,
      includeDirectories: this.settings.includeDirectories,
      packagePhysicalPaths: this.packageResolver.asIncludeContextMap(),
    };

    await this.fullScan(connection);
  }

  private async indexAndStore(absPath: string, connection?: Connection): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    try {
      const text = await fs.readFile(absPath, 'utf8');
      const idx = await indexFile(uri, text, this.table);
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

  drop(uri: string): void {
    this.store.delete(uri);
    this.global.delete(uri);
  }
}
