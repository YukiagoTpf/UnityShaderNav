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
import { CacheStore } from './cacheStore';

export interface CacheLocationInput {
  unityProjectRoot: string | undefined;
  workspaceFolderUri: string;
  globalStorageDir: string | undefined;
}

/**
 * Pick the on-disk cache directory for a workspace: Library/UnityShaderNavCache under a
 * Unity root, else a per-workspace bucket in the extension's global storage, else null
 * (no cache). Internal to the cache module — not re-exported from the barrel.
 */
export function chooseCacheDir(input: CacheLocationInput): string | null {
  if (input.unityProjectRoot) {
    return join(input.unityProjectRoot, 'Library', 'UnityShaderNavCache');
  }

  if (input.globalStorageDir) {
    const hash = createHash('sha1')
      .update(input.workspaceFolderUri)
      .digest('hex')
      .slice(0, 16);
    return join(input.globalStorageDir, 'standalone', hash);
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

  async save(manifest: CacheManifest): Promise<void> {
    await this.store.save(manifest);
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

  async snapshot(uri: string, index: FileIndex): Promise<CachedFile | null> {
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
}
