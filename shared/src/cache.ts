import type { FileIndex } from './symbols';

export const CACHE_VERSION = 8;

/**
 * Fields that invalidate the whole cache when changed between runs.
 * Values are deterministic, JSON-friendly content identities.
 */
export interface CacheFingerprint {
  /** SHA-256 of the actual server and parser runtime that produced FileIndex. */
  indexImplementation: string;
  /** SHA-256 of the exact vendored grammar bytes loaded by the running parser. */
  grammarVersion: string;
  /** SHA-1 over settings keys that influence indexing. */
  settingsHash: string;
  /** SHA-1 over the resolved builtin + user macro pattern table. */
  macroTableHash: string;
}

export interface CachedFile {
  uri: string;
  mtimeMs: number;
  size: number;
  index: FileIndex;
}

export interface CacheManifest {
  version: number;
  workspaceFolderUri: string;
  unityProjectRoot: string | null;
  createdAt: number;
  fingerprint: CacheFingerprint;
  files: CachedFile[];
}
