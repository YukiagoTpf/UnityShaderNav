import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_VERSION, type CacheFingerprint } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { CacheStore } from '../../src/cache/cacheStore';

describe('CacheStore', () => {
  it('returns null when no manifest exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-missing-'));
    const store = new CacheStore(dir);

    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('saves and loads a valid manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-valid-'));
    const store = new CacheStore(dir);
    const fingerprint: CacheFingerprint = {
      grammarVersion: 'g1',
      settingsHash: 's1',
      macroTableHash: 'm1',
    };

    await store.save({
      version: CACHE_VERSION,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint,
      files: [],
    });

    expect(await store.load(fingerprint)).toMatchObject({
      version: CACHE_VERSION,
      workspaceFolderUri: 'file:///x',
      fingerprint,
    });

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for malformed JSON or unsupported versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-invalid-'));
    const store = new CacheStore(dir);

    await writeFile(join(dir, 'index.json'), '{nope', 'utf8');
    expect(await store.load()).toBeNull();

    await writeFile(join(dir, 'index.json'), JSON.stringify({
      version: CACHE_VERSION + 1,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: 123,
      fingerprint: { grammarVersion: 'g', settingsHash: 's', macroTableHash: 'm' },
      files: [],
    }), 'utf8');
    expect(await store.load()).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when fingerprint mismatches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-fp-'));
    const store = new CacheStore(dir);
    const fpA: CacheFingerprint = {
      grammarVersion: 'a',
      settingsHash: 's1',
      macroTableHash: 'm1',
    };
    const fpB: CacheFingerprint = {
      grammarVersion: 'b',
      settingsHash: 's1',
      macroTableHash: 'm1',
    };

    await store.save({
      version: CACHE_VERSION,
      workspaceFolderUri: 'file:///x',
      unityProjectRoot: '/x',
      createdAt: Date.now(),
      fingerprint: fpA,
      files: [],
    });

    expect(await store.load(fpA)).not.toBeNull();
    expect(await store.load(fpB)).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });
});
