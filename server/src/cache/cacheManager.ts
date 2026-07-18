import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CACHE_VERSION,
  type CachedFile,
  type CacheFingerprint,
  type CacheManifest,
  type FileIndex,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type { FileIdentityOptions } from '../fileIdentity';
import {
  samePath,
  type PathIdentityOptions,
} from '../pathIdentity';
import { CacheStore } from './cacheStore';

export interface CacheLocationInput {
  unityProjectRoot: string | undefined;
  workspaceFolderUri: string;
  globalStorageDir: string | undefined;
}

export interface CachePublicationFile {
  readonly uri: string;
  readonly index: FileIndex;
  readonly source: Pick<CachedFile, 'mtimeMs' | 'size'>;
}

export interface CachePublicationInput {
  readonly workspaceFolderUri: string;
  readonly unityProjectRoot: string | null;
  readonly fingerprint: CacheFingerprint;
  readonly files: readonly CachePublicationFile[];
}

export interface CacheWorkspaceIdentity {
  readonly workspaceFolderUri: string;
  readonly unityProjectRoot: string | null;
}

interface PublicationWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingPublication {
  run: () => Promise<void>;
  readonly waiters: PublicationWaiter[];
}

interface PublicationQueue {
  pending: PendingPublication | undefined;
}

const publicationQueues = new Map<string, PublicationQueue>();

export function workspaceCacheIdentity(
  workspaceFolderUri: string,
  identityOptions: FileIdentityOptions = {},
): string {
  return createHash('sha1')
    .update(uriKey(workspaceFolderUri, identityOptions))
    .digest('hex')
    .slice(0, 16);
}

/** Match the manifest identity using the same URI and path rules as cache routing. */
export function cacheWorkspaceMatches(
  manifest: CacheWorkspaceIdentity,
  expected: CacheWorkspaceIdentity,
  pathOptions: PathIdentityOptions = {},
): boolean {
  if (
    uriKey(manifest.workspaceFolderUri, pathOptions)
    !== uriKey(expected.workspaceFolderUri, pathOptions)
  ) {
    return false;
  }
  if (manifest.unityProjectRoot === null || expected.unityProjectRoot === null) {
    return manifest.unityProjectRoot === expected.unityProjectRoot;
  }
  return samePath(manifest.unityProjectRoot, expected.unityProjectRoot, pathOptions);
}

/**
 * Pick the on-disk cache directory for a workspace: Library/UnityShaderNavCache under a
 * Unity root, else a per-workspace bucket in the extension's global storage, else null
 * (no cache). Internal to the cache module — not re-exported from the barrel.
 */
export function chooseCacheDir(input: CacheLocationInput): string | null {
  const identity = workspaceCacheIdentity(input.workspaceFolderUri);
  if (input.unityProjectRoot) {
    return join(
      input.unityProjectRoot,
      'Library',
      'UnityShaderNavCache',
      'workspaces',
      identity,
    );
  }

  if (input.globalStorageDir) {
    return join(input.globalStorageDir, 'standalone', identity);
  }

  return null;
}

export class CacheManager {
  constructor(private readonly store: CacheStore) {}

  /**
   * Build a manager for a workspace's cache location, or undefined when no cache
   * directory applies (no Unity root and no global storage). Folds the former
   * chooseCacheDir + CacheStore construction that workspace bootstrap used to do.
   */
  static create(input: CacheLocationInput): CacheManager | undefined {
    const dir = chooseCacheDir(input);
    return dir ? new CacheManager(new CacheStore(dir)) : undefined;
  }

  async load(fingerprint?: CacheFingerprint): Promise<CacheManifest | null> {
    return this.store.load(fingerprint);
  }

  /**
   * Persist one immutable revision projection. Enqueueing happens before any
   * asynchronous manifest preparation so request order, not completion order,
   * determines which pending publication is retained.
   */
  persistPublication(
    input: CachePublicationInput,
    shouldCommit: () => boolean = () => true,
  ): Promise<void> {
    const publication: CachePublicationInput = {
      ...input,
      files: input.files.map((file) => ({
        uri: file.uri,
        index: file.index,
        source: { ...file.source },
      })),
    };
    return enqueueLatestPublication(
      this.store.coordinationKey,
      () => this.writePublication(publication, shouldCommit),
    );
  }

  async isValid(file: CachedFile): Promise<boolean> {
    try {
      const filePath = fileURLToPath(file.uri);
      const st = await fs.stat(filePath);
      return st.mtimeMs === file.mtimeMs && st.size === file.size;
    } catch {
      return false;
    }
  }

  async snapshot(
    uri: string,
    index: FileIndex,
    source?: Pick<CachedFile, 'mtimeMs' | 'size'>,
  ): Promise<CachedFile | null> {
    if (source) return { uri, index, ...source };
    try {
      const filePath = fileURLToPath(uri);
      const st = await fs.stat(filePath);
      return {
        uri,
        mtimeMs: st.mtimeMs,
        size: st.size,
        index,
      };
    } catch {
      return null;
    }
  }

  buildManifest(
    workspaceFolderUri: string,
    unityProjectRoot: string | null,
    fingerprint: CacheFingerprint,
    files: CachedFile[],
  ): CacheManifest {
    return {
      version: CACHE_VERSION,
      workspaceFolderUri,
      unityProjectRoot,
      createdAt: Date.now(),
      fingerprint,
      files,
    };
  }

  private async writePublication(
    input: CachePublicationInput,
    shouldCommit: () => boolean,
  ): Promise<void> {
    const snapshots = await Promise.all(input.files.map(({ uri, index, source }) => (
      this.snapshot(uri, index, source)
    )));
    if (!shouldCommit()) return;
    const files = snapshots
      .filter((snapshot): snapshot is CachedFile => snapshot !== null)
      .sort((left, right) => left.uri.localeCompare(right.uri));
    await this.store.save(this.buildManifest(
      input.workspaceFolderUri,
      input.unityProjectRoot,
      input.fingerprint,
      files,
    ));
  }
}

function enqueueLatestPublication(
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const waiter = { resolve, reject };
    const queue = publicationQueues.get(key);
    if (!queue) {
      const created: PublicationQueue = { pending: undefined };
      publicationQueues.set(key, created);
      void drainPublications(key, created, { run, waiters: [waiter] });
      return;
    }

    if (queue.pending) {
      queue.pending.run = run;
      queue.pending.waiters.push(waiter);
    } else {
      queue.pending = { run, waiters: [waiter] };
    }
  });
}

async function drainPublications(
  key: string,
  queue: PublicationQueue,
  initial: PendingPublication,
): Promise<void> {
  let current: PendingPublication | undefined = initial;
  while (current) {
    try {
      await current.run();
      for (const waiter of current.waiters) waiter.resolve();
    } catch (error) {
      for (const waiter of current.waiters) waiter.reject(error);
    }
    current = queue.pending;
    queue.pending = undefined;
  }
  if (publicationQueues.get(key) === queue) publicationQueues.delete(key);
}
