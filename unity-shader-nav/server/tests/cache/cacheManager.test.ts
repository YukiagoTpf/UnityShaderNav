import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE_VERSION, type CacheFingerprint } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { CacheManager, chooseCacheDir } from '../../src/cache/cacheManager';
import { CacheStore } from '../../src/cache/cacheStore';

describe('CacheManager.isValid', () => {
  it('returns true when mtime and size are unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-mgr-'));
    const filePath = join(dir, 'a.hlsl');
    await writeFile(filePath, 'float4 x;');
    const st = await stat(filePath);
    const manager = new CacheManager(new CacheStore(dir));

    const ok = await manager.isValid({
      uri: pathToFileURL(filePath).href,
      mtimeMs: st.mtimeMs,
      size: st.size,
      index: { uri: pathToFileURL(filePath).href, symbols: [], references: [] },
    });

    expect(ok).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it('returns false when the file changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-mgr-changed-'));
    const filePath = join(dir, 'a.hlsl');
    await writeFile(filePath, 'float4 x;');
    const st = await stat(filePath);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(filePath, 'float4 xx; // changed');
    const manager = new CacheManager(new CacheStore(dir));

    const ok = await manager.isValid({
      uri: pathToFileURL(filePath).href,
      mtimeMs: st.mtimeMs,
      size: st.size,
      index: { uri: pathToFileURL(filePath).href, symbols: [], references: [] },
    });

    expect(ok).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('CacheManager.snapshot', () => {
  it('captures file metadata next to an index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-mgr-snapshot-'));
    const filePath = join(dir, 'a.hlsl');
    const uri = pathToFileURL(filePath).href;
    await writeFile(filePath, 'float4 x;');
    const manager = new CacheManager(new CacheStore(dir));

    const snapshot = await manager.snapshot(uri, { uri, symbols: [], references: [] });

    expect(snapshot).toMatchObject({
      uri,
      index: { uri, symbols: [], references: [] },
    });
    expect(snapshot?.mtimeMs).toBeGreaterThan(0);
    expect(snapshot?.size).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('CacheManager.buildManifest', () => {
  it('builds a versioned manifest with the provided fingerprint and files', () => {
    const manager = new CacheManager(new CacheStore('/tmp/no-write'));
    const fingerprint: CacheFingerprint = {
      grammarVersion: 'g',
      settingsHash: 's',
      macroTableHash: 'm',
    };

    const manifest = manager.buildManifest('file:///workspace', '/workspace', fingerprint, []);

    expect(manifest).toMatchObject({
      version: CACHE_VERSION,
      workspaceFolderUri: 'file:///workspace',
      unityProjectRoot: '/workspace',
      fingerprint,
      files: [],
    });
    expect(manifest.createdAt).toBeGreaterThan(0);
  });
});

describe('chooseCacheDir', () => {
  it('uses Library/UnityShaderNavCache under unity root', () => {
    expect(chooseCacheDir({
      unityProjectRoot: '/proj',
      workspaceFolderUri: 'file:///proj',
      globalStorageDir: '/gs',
    })).toBe(join('/proj', 'Library', 'UnityShaderNavCache'));
  });

  it('falls back to globalStorageDir bucket in standalone mode', () => {
    const out = chooseCacheDir({
      unityProjectRoot: undefined,
      workspaceFolderUri: 'file:///x',
      globalStorageDir: '/gs',
    });

    expect(out).not.toBeNull();
    expect(out?.replaceAll('\\', '/')).toMatch(/^\/gs\/standalone\/[a-f0-9]{16}$/);
  });

  it('returns null when no location is available', () => {
    expect(chooseCacheDir({
      unityProjectRoot: undefined,
      workspaceFolderUri: 'file:///x',
      globalStorageDir: undefined,
    })).toBeNull();
  });
});

describe('CacheManager.create', () => {
  it('builds a manager when a cache directory applies', () => {
    const manager = CacheManager.create({
      unityProjectRoot: '/proj',
      workspaceFolderUri: 'file:///proj',
      globalStorageDir: undefined,
    });

    expect(manager).toBeInstanceOf(CacheManager);
  });

  it('returns undefined when no cache directory applies', () => {
    const manager = CacheManager.create({
      unityProjectRoot: undefined,
      workspaceFolderUri: 'file:///x',
      globalStorageDir: undefined,
    });

    expect(manager).toBeUndefined();
  });
});
