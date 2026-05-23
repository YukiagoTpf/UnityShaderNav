import type { FileIndex } from './symbols';

export const CACHE_VERSION = 2;

/**
 * Fields that invalidate the whole cache when changed between runs.
 * Each value is a stable hex digest so manifests stay JSON-friendly.
 */
export interface CacheFingerprint {
  /** SHA-1 of the vendored tree-sitter-hlsl.wasm bytes, or a fixed sentinel. */
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
