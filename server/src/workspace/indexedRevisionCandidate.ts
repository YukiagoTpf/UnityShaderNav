import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type {
  CacheFingerprint,
  CacheManifest,
  ExtensionSettings,
} from '@unity-shader-nav/shared';
import { CacheManager, cacheWorkspaceMatches } from '../cache';
import { buildFingerprint } from '../cache/fingerprint';
import { runningIndexImplementationIdentity } from '../cache/implementationIdentity';
import { PackageContext } from '../packages';
import { ensureParserReady } from '../parser/hlsl';
import {
  resolveRunningParserRuntimeAssets,
  type ParserRuntimeAssets,
} from '../parser/runtimeAssets';
import { mapWithConcurrency } from './concurrency';
import { detectUnityRoot } from './detectUnityRoot';
import { IndexInfrastructureError } from './indexLifecycle';
import {
  IndexedRevisionBuilder,
  type PublishedIndexedRevision,
} from './indexedRevision';
import { IndexedSourceMembership } from './indexedSourceMembership';
import type {
  DocumentAnalyzer,
  DocumentIndexer,
} from './workspaceIndex';

const INDEX_CONCURRENCY = 8;
const CACHE_IO_CONCURRENCY = 32;

export interface IndexedRevisionCandidateConstructionInput {
  readonly connection: Connection;
  readonly settings: ExtensionSettings;
  readonly globalStorageDir?: string;
  readonly previous?: PublishedIndexedRevision;
  readonly signal: AbortSignal;
  /** Reports root detection only; the caller remains the observable mode owner. */
  readonly onModeResolved?: (mode: 'unity' | 'standalone') => void;
}

/** Produces one complete, unpublished revision candidate. */
export interface IndexedRevisionCandidateConstructor {
  construct(
    input: IndexedRevisionCandidateConstructionInput,
  ): Promise<IndexedRevisionBuilder>;
}

export interface DefaultIndexedRevisionCandidateConstructorOptions {
  readonly folderUri: string;
  readonly indexImplementation?: string | null;
  readonly ensureParserReady?: () => Promise<ParserRuntimeAssets | void>;
  readonly resolveParserRuntimeAssets?: () => ParserRuntimeAssets;
  readonly indexDocument?: DocumentIndexer;
  readonly analyzeDocument?: DocumentAnalyzer;
}

export function createStandalonePackageContext(
  settings: ExtensionSettings,
): PackageContext {
  return PackageContext.standalone(settings);
}

export function createDefaultIndexedRevisionCandidateConstructor(
  folderUri: string,
  options: Omit<DefaultIndexedRevisionCandidateConstructorOptions, 'folderUri'> = {},
): IndexedRevisionCandidateConstructor {
  return new DefaultIndexedRevisionCandidateConstructor({ folderUri, ...options });
}

interface CacheConfiguration {
  readonly cache: CacheManager | undefined;
  readonly fingerprint: CacheFingerprint | undefined;
}

/**
 * Default construction pipeline shared by cold start, warm restore, rebuild,
 * and recovery. It owns candidate inputs and never publishes a revision.
 */
export class DefaultIndexedRevisionCandidateConstructor
  implements IndexedRevisionCandidateConstructor {
  private readonly folderUri: string;
  private readonly indexImplementation: string | null | undefined;
  private readonly parserReady: () => Promise<ParserRuntimeAssets | void>;
  private readonly resolveRuntimeAssets: () => ParserRuntimeAssets;
  private readonly indexDocument: DocumentIndexer | undefined;
  private readonly analyzeDocument: DocumentAnalyzer | undefined;

  constructor(options: DefaultIndexedRevisionCandidateConstructorOptions) {
    this.folderUri = options.folderUri;
    this.indexImplementation = options.indexImplementation;
    this.parserReady = options.ensureParserReady ?? ensureParserReady;
    this.resolveRuntimeAssets = options.resolveParserRuntimeAssets
      ?? resolveRunningParserRuntimeAssets;
    this.indexDocument = options.indexDocument;
    this.analyzeDocument = options.analyzeDocument;
  }

  async construct(
    input: IndexedRevisionCandidateConstructionInput,
  ): Promise<IndexedRevisionBuilder> {
    this.throwIfAborted(input.signal);
    const folderPath = fileURLToPath(this.folderUri);
    const configuredRoot = input.settings.projectRoot.trim();
    const unityRoot = configuredRoot || await detectUnityRoot(folderPath) || undefined;
    this.throwIfAborted(input.signal);
    input.onModeResolved?.(unityRoot ? 'unity' : 'standalone');

    const packages = await this.loadPackages(unityRoot, input.settings, input.signal);
    const runtimeAssets = await this.preflightParser(input.signal);
    const cacheConfiguration = await this.configureCache(
      unityRoot,
      input.settings,
      input.globalStorageDir,
      input.connection,
      runtimeAssets,
      input.signal,
    );
    const membership = IndexedSourceMembership.create({
      folderUri: this.folderUri,
      settings: input.settings,
      unityRoot,
      packages,
    });
    const builder = IndexedRevisionBuilder.create({
      folderUri: this.folderUri,
      settings: input.settings,
      unityRoot,
      packages,
      membership,
      ...cacheConfiguration,
    }, this.indexDocument, this.analyzeDocument);
    const compatiblePrevious = this.isCompatiblePrevious(
      input.previous,
      unityRoot,
      packages,
      cacheConfiguration.fingerprint,
    );

    const manifest = await cacheConfiguration.cache?.load(cacheConfiguration.fingerprint);
    this.throwIfAborted(input.signal);
    if (manifest && cacheWorkspaceMatches(manifest, {
      workspaceFolderUri: this.folderUri,
      unityProjectRoot: unityRoot ?? null,
    })) {
      await this.restoreCandidateFromCache({
        ...input,
        builder,
        manifest,
        cache: cacheConfiguration.cache!,
        unityRoot,
        packages,
        membership,
        compatiblePrevious,
      });
      this.throwIfAborted(input.signal);
      return builder;
    }

    if (unityRoot) {
      await this.scanCandidate({
        ...input,
        builder,
        unityRoot,
        packages,
        membership,
        compatiblePrevious,
      });
    }
    this.throwIfAborted(input.signal);
    return builder;
  }

  private async loadPackages(
    unityRoot: string | undefined,
    settings: ExtensionSettings,
    signal: AbortSignal,
  ): Promise<PackageContext> {
    if (!unityRoot) return createStandalonePackageContext(settings);
    try {
      const packages = await PackageContext.load(unityRoot, settings);
      this.throwIfAborted(signal);
      return packages;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : String(error);
      throw new IndexInfrastructureError('package-resolution', message, { cause: error });
    }
  }

  private async preflightParser(signal: AbortSignal): Promise<ParserRuntimeAssets> {
    try {
      const readyAssets = await this.parserReady();
      this.throwIfAborted(signal);
      return readyAssets ?? this.resolveRuntimeAssets();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : String(error);
      throw new IndexInfrastructureError(
        'parser-initialization',
        `Unable to initialize the shader parser: ${message}`,
        { cause: error },
      );
    }
  }

  private async configureCache(
    unityRoot: string | undefined,
    settings: ExtensionSettings,
    globalStorageDir: string | undefined,
    connection: Connection,
    runtimeAssets: ParserRuntimeAssets,
    signal: AbortSignal,
  ): Promise<CacheConfiguration> {
    let cache = CacheManager.create({
      unityProjectRoot: unityRoot,
      workspaceFolderUri: this.folderUri,
      globalStorageDir,
    });
    if (!cache) return { cache: undefined, fingerprint: undefined };

    const indexImplementation = this.indexImplementation === undefined
      ? runningIndexImplementationIdentity(runtimeAssets)
      : this.indexImplementation ?? undefined;
    const fingerprint = buildFingerprint(
      settings,
      runtimeAssets,
      indexImplementation,
    );
    this.throwIfAborted(signal);
    if (!fingerprint) {
      connection.console.warn(
        'Index cache disabled: the running index implementation could not be identified.',
      );
      cache = undefined;
    }
    return { cache, fingerprint: cache ? fingerprint : undefined };
  }

  private async restoreCandidateFromCache(
    input: IndexedRevisionCandidateConstructionInput & {
      readonly builder: IndexedRevisionBuilder;
      readonly manifest: CacheManifest;
      readonly cache: CacheManager;
      readonly unityRoot: string | undefined;
      readonly packages: PackageContext;
      readonly membership: IndexedSourceMembership;
      readonly compatiblePrevious: boolean;
    },
  ): Promise<void> {
    const progress = await input.connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'restoring cache...', false);
    const refreshQueue: string[] = [];
    try {
      const restoreResults = await mapWithConcurrency(
        input.manifest.files,
        CACHE_IO_CONCURRENCY,
        async (cachedFile) => {
          this.throwIfAborted(input.signal);
          const valid = input.membership.containsUri(cachedFile.uri)
            && await input.cache.isValid(cachedFile);
          this.throwIfAborted(input.signal);
          return { cachedFile, valid };
        },
      );

      for (const { cachedFile, valid } of restoreResults) {
        this.throwIfAborted(input.signal);
        if (!input.membership.containsUri(cachedFile.uri)) continue;
        if (valid) {
          input.builder.restoreFromCache(cachedFile.uri, cachedFile.index, {
            mtimeMs: cachedFile.mtimeMs,
            size: cachedFile.size,
          });
        } else if (await fileExists(cachedFile.uri)) {
          refreshQueue.push(cachedFile.uri);
        }
      }

      progress.report(`re-parsing ${refreshQueue.length} changed files...`);
      await mapWithConcurrency(refreshQueue, INDEX_CONCURRENCY, async (uri) => {
        this.throwIfAborted(input.signal);
        const indexed = await input.builder.indexAndStore(
          fileURLToPath(uri),
          input.connection,
          () => !input.signal.aborted,
        );
        this.throwIfAborted(input.signal);
        this.retainCompatibleSourceFailure(input, uri, indexed);
      });
      if (input.unityRoot) {
        await this.indexMissingDiskFiles({ ...input, unityRoot: input.unityRoot });
      }
    } finally {
      progress.done();
    }
  }

  private async indexMissingDiskFiles(
    input: IndexedRevisionCandidateConstructionInput & {
      readonly builder: IndexedRevisionBuilder;
      readonly unityRoot: string;
      readonly packages: PackageContext;
      readonly membership: IndexedSourceMembership;
      readonly compatiblePrevious: boolean;
    },
  ): Promise<void> {
    const { userFiles, packageFiles } = await input.membership.discover(input.signal);
    await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (filePath) => {
      this.throwIfAborted(input.signal);
      const uri = pathToFileURL(filePath).href;
      if (input.builder.file(uri)) return;
      const indexed = await input.builder.indexAndStore(
        filePath,
        input.connection,
        () => !input.signal.aborted,
      );
      this.throwIfAborted(input.signal);
      this.retainCompatibleSourceFailure(input, uri, indexed);
    });

    await mapWithConcurrency(packageFiles, INDEX_CONCURRENCY, async (filePath) => {
      this.throwIfAborted(input.signal);
      const uri = pathToFileURL(filePath).href;
      if (input.builder.file(uri)) return;
      const indexed = await input.builder.indexAndStore(
        filePath,
        input.connection,
        () => !input.signal.aborted,
      );
      this.throwIfAborted(input.signal);
      this.retainCompatibleSourceFailure(input, uri, indexed);
    });
  }

  private async scanCandidate(
    input: IndexedRevisionCandidateConstructionInput & {
      readonly builder: IndexedRevisionBuilder;
      readonly unityRoot: string;
      readonly packages: PackageContext;
      readonly membership: IndexedSourceMembership;
      readonly compatiblePrevious: boolean;
    },
  ): Promise<void> {
    const progress = await input.connection.window.createWorkDoneProgress();
    progress.begin('UnityShaderNav', undefined, 'indexing user files...', false);
    try {
      const { userFiles, packageFiles } = await input.membership.discover(input.signal);
      let done = 0;
      await mapWithConcurrency(userFiles, INDEX_CONCURRENCY, async (filePath) => {
        this.throwIfAborted(input.signal);
        const uri = pathToFileURL(filePath).href;
        const indexed = await input.builder.indexAndStore(
          filePath,
          input.connection,
          () => !input.signal.aborted,
        );
        this.throwIfAborted(input.signal);
        this.retainCompatibleSourceFailure(input, uri, indexed);
        done++;
        if (done % 25 === 0) progress.report(`${done}/${userFiles.length} files`);
      });

      progress.report('indexing Packages...');
      await mapWithConcurrency(packageFiles, INDEX_CONCURRENCY, async (filePath) => {
        this.throwIfAborted(input.signal);
        const uri = pathToFileURL(filePath).href;
        const indexed = await input.builder.indexAndStore(
          filePath,
          input.connection,
          () => !input.signal.aborted,
        );
        this.throwIfAborted(input.signal);
        this.retainCompatibleSourceFailure(input, uri, indexed);
      });
    } finally {
      progress.done();
    }
  }

  private retainCompatibleSourceFailure(
    input: {
      readonly builder: IndexedRevisionBuilder;
      readonly previous?: PublishedIndexedRevision;
      readonly compatiblePrevious: boolean;
    },
    uri: string,
    indexed: boolean,
  ): void {
    if (indexed) return;
    const previousRecord = input.previous?.diskRecord(uri);
    if (!previousRecord) return;
    if (!input.compatiblePrevious) {
      throw new IndexInfrastructureError(
        'indexing',
        `Cannot retain unreadable source across incompatible index semantics: ${uri}`,
      );
    }
    input.builder.restoreFromCache(uri, previousRecord.index, previousRecord.source);
    input.builder.recordSourceResult(uri, false);
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

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
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
