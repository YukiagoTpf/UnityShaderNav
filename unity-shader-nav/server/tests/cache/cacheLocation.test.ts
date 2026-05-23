import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseCacheDir } from '../../src/cache/cacheLocation';

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
