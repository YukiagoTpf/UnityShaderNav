import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CACHE_VERSION, type CacheFingerprint } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import {
  CacheManager,
  cacheWorkspaceMatches,
  chooseCacheDir,
  workspaceCacheIdentity,
} from '../../src/cache/cacheManager';
import { CacheStore } from '../../src/cache/cacheStore';
import { pathIdentity, samePath } from '../../src/pathIdentity';

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
      indexImplementation: 'a'.repeat(64),
      grammarVersion: 'c'.repeat(64),
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
  it('partitions parent and nested workspaces under one Unity root with stable identities', () => {
    const parent = chooseCacheDir({
      unityProjectRoot: '/proj',
      workspaceFolderUri: 'file:///proj',
      globalStorageDir: '/gs',
    });
    const nestedInput = {
      unityProjectRoot: '/proj',
      workspaceFolderUri: 'file:///proj/Assets/Feature',
      globalStorageDir: '/gs',
    };
    const nested = chooseCacheDir(nestedInput);

    expect(parent?.replaceAll('\\', '/')).toMatch(
      /^\/proj\/Library\/UnityShaderNavCache\/workspaces\/[a-f0-9]{16}$/,
    );
    expect(nested?.replaceAll('\\', '/')).toMatch(
      /^\/proj\/Library\/UnityShaderNavCache\/workspaces\/[a-f0-9]{16}$/,
    );
    expect(parent).not.toBe(nested);
    expect(chooseCacheDir(nestedInput)).toBe(nested);
  });

  it('treats Windows drive-letter case as the same workspace identity', () => {
    const upperDrive = chooseCacheDir({
      unityProjectRoot: '/proj',
      workspaceFolderUri: 'file:///C:/Unity/Project/Assets',
      globalStorageDir: undefined,
    });
    const lowerDrive = chooseCacheDir({
      unityProjectRoot: '/proj',
      workspaceFolderUri: 'file:///c:/Unity/Project/Assets',
      globalStorageDir: undefined,
    });

    expect(upperDrive).toBe(lowerDrive);
  });

  it('canonicalizes equivalent Windows manifest paths used as coordinator keys', () => {
    const upperPath = String.raw`C:\Unity\Project\Library\UnityShaderNavCache\index.json`;
    const lowerPath = String.raw`c:\unity\project\library\unityshadernavcache\index.json`;
    const windows = { path: win32, platform: 'win32' as const };

    expect(pathIdentity(upperPath, windows)).toBe(pathIdentity(lowerPath, windows));
    expect(samePath(upperPath, lowerPath, windows)).toBe(true);
  });

  it('matches equivalent Windows URI and Unity-root casing for cache restore', () => {
    expect(cacheWorkspaceMatches(
      {
        workspaceFolderUri: 'file:///C:/Unity/Project',
        unityProjectRoot: String.raw`C:\Unity\Project`,
      },
      {
        workspaceFolderUri: 'file:///c:/Unity/Project',
        unityProjectRoot: String.raw`c:\unity\project`,
      },
      { path: win32, platform: 'win32' },
    )).toBe(true);
  });

  it('uses one cache bucket for macOS case and Unicode URI variants', () => {
    const nfc = pathToFileURL('/project/Café/Workspace').href;
    const nfd = pathToFileURL('/PROJECT/CAFÉ/workspace').href;

    expect(workspaceCacheIdentity(nfc, { platform: 'darwin' })).toBe(
      workspaceCacheIdentity(nfd, { platform: 'darwin' }),
    );
    expect(cacheWorkspaceMatches(
      { workspaceFolderUri: nfc, unityProjectRoot: '/project/Café/Workspace' },
      { workspaceFolderUri: nfd, unityProjectRoot: '/PROJECT/CAFÉ/workspace' },
      { platform: 'darwin' },
    )).toBe(true);
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
