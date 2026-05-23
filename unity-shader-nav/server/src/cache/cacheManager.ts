import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CACHE_VERSION,
  type CachedFile,
  type CacheFingerprint,
  type CacheManifest,
  type FileIndex,
} from '@unity-shader-nav/shared';
import { CacheStore } from './cacheStore';

export class CacheManager {
  constructor(private readonly store: CacheStore) {}

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
