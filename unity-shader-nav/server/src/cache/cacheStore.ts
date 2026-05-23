import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_VERSION,
  type CacheFingerprint,
  type CacheManifest,
} from '@unity-shader-nav/shared';
import { fingerprintsEqual } from './fingerprint';

export class CacheStore {
  private static readonly saveQueues = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, 'index.json');
  }

  async load(expectedFingerprint?: CacheFingerprint): Promise<CacheManifest | null> {
    let content: string;
    try {
      content = await fs.readFile(this.path, 'utf8');
    } catch {
      return null;
    }

    let parsed: CacheManifest;
    try {
      parsed = JSON.parse(content) as CacheManifest;
    } catch {
      return null;
    }

    if (parsed.version !== CACHE_VERSION) return null;
    if (!parsed.fingerprint) return null;
    if (expectedFingerprint && !fingerprintsEqual(parsed.fingerprint, expectedFingerprint)) {
      return null;
    }

    return parsed;
  }

  async save(manifest: CacheManifest): Promise<void> {
    const previous = CacheStore.saveQueues.get(this.path) ?? Promise.resolve();
    const current = previous.then(
      () => this.writeManifest(manifest),
      () => this.writeManifest(manifest),
    );
    CacheStore.saveQueues.set(this.path, current);
    try {
      await current;
    } finally {
      if (CacheStore.saveQueues.get(this.path) === current) {
        CacheStore.saveQueues.delete(this.path);
      }
    }
  }

  private async writeManifest(manifest: CacheManifest): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(manifest), 'utf8');
    await fs.rm(this.path, { force: true });
    await fs.rename(tmpPath, this.path);
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.path);
    } catch {
      // Missing cache files are already clear.
    }
  }
}
