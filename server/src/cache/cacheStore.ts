import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_VERSION,
  type CachedFile,
  type CacheFingerprint,
  type CacheManifest,
} from '@unity-shader-nav/shared';
import { pathIdentity } from '../pathIdentity';
import { fingerprintsEqual } from './fingerprint';
import { decodePersistedFileIndex } from './fileIndexCodec';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCacheFingerprint(value: unknown): value is CacheFingerprint {
  return isRecord(value)
    && typeof value.indexImplementation === 'string'
    && /^[0-9a-f]{64}$/.test(value.indexImplementation)
    && typeof value.grammarVersion === 'string'
    && /^[0-9a-f]{64}$/.test(value.grammarVersion)
    && typeof value.settingsHash === 'string'
    && typeof value.macroTableHash === 'string';
}

function decodeCachedFile(value: unknown): CachedFile | null {
  if (
    !isRecord(value)
    || typeof value.uri !== 'string'
    || !isFiniteNumber(value.mtimeMs)
    || !isFiniteNumber(value.size)
  ) return null;
  const index = decodePersistedFileIndex(value.index, value.uri);
  return index
    ? { uri: value.uri, mtimeMs: value.mtimeMs, size: value.size, index }
    : null;
}

function toCacheManifest(value: unknown): CacheManifest | null {
  if (
    !isRecord(value)
    || value.version !== CACHE_VERSION
    || typeof value.workspaceFolderUri !== 'string'
    || !(typeof value.unityProjectRoot === 'string' || value.unityProjectRoot === null)
    || !isFiniteNumber(value.createdAt)
    || !isCacheFingerprint(value.fingerprint)
    || !Array.isArray(value.files)
  ) {
    return null;
  }

  const files: CachedFile[] = [];
  for (const entry of value.files) {
    const file = decodeCachedFile(entry);
    if (file) files.push(file);
  }

  return {
    version: value.version,
    workspaceFolderUri: value.workspaceFolderUri,
    unityProjectRoot: value.unityProjectRoot,
    createdAt: value.createdAt,
    fingerprint: value.fingerprint,
    // CacheStore owns persisted JSON hygiene; malformed file records are skipped
    // before Workspace restore can poison indexes or throw on bad shapes.
    files,
  };
}

export class CacheStore {
  private static readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, 'index.json');
  }

  /** Canonical key shared by stores targeting the same manifest on this platform. */
  get coordinationKey(): string {
    return pathIdentity(this.path);
  }

  async load(expectedFingerprint?: CacheFingerprint): Promise<CacheManifest | null> {
    let content: string;
    try {
      content = await fs.readFile(this.path, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    const manifest = toCacheManifest(parsed);
    if (!manifest) return null;
    if (expectedFingerprint && !fingerprintsEqual(manifest.fingerprint, expectedFingerprint)) {
      return null;
    }

    return manifest;
  }

  async save(manifest: CacheManifest): Promise<void> {
    const previous = CacheStore.saveQueues.get(this.coordinationKey) ?? Promise.resolve();
    const current = previous.then(
      () => this.writeManifest(manifest),
      () => this.writeManifest(manifest),
    );
    CacheStore.saveQueues.set(this.coordinationKey, current);
    try {
      await current;
    } finally {
      if (CacheStore.saveQueues.get(this.coordinationKey) === current) {
        CacheStore.saveQueues.delete(this.coordinationKey);
      }
    }
  }

  private async writeManifest(manifest: CacheManifest): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(manifest), 'utf8');
      await fs.rename(tmpPath, this.path);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.path);
    } catch {
      // Missing cache files are already clear.
    }
  }
}
