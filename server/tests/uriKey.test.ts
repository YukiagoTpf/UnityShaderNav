import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizePathForComparison } from '../src/pathIdentity';
import { uriKey } from '../src/uriKey';

describe('uriKey', () => {
  it('normalizes macOS case and Unicode composition before re-encoding', () => {
    const nfc = pathToFileURL('/Users/Café/Éclair.shader').href;
    const nfd = pathToFileURL('/users/CAFÉ/ÉCLAIR.shader').href;

    expect(uriKey(nfc, { platform: 'darwin' })).toBe(
      'file:///users/caf%C3%A9/%C3%A9clair.shader',
    );
    expect(uriKey(nfd, { platform: 'darwin' })).toBe(uriKey(nfc, { platform: 'darwin' }));
  });

  it('folds the complete path for intrinsically Windows file URIs', () => {
    const plain = 'file:///C:/Unity/Project/My%20Shader.shader';
    const encodedDrive = 'file:///c%3A/unity/project/my%20shader.shader';

    expect(uriKey(plain, { platform: 'linux' })).toBe(
      'file:///c:/unity/project/my%20shader.shader',
    );
    expect(uriKey(encodedDrive, { platform: 'linux' })).toBe(uriKey(plain, { platform: 'linux' }));
  });

  it('preserves Linux case and Unicode normalization distinctions', () => {
    const nfc = pathToFileURL('/Project/Café/Main.shader').href;
    const nfd = pathToFileURL('/project/Café/Main.shader').href;

    expect(uriKey(nfc, { platform: 'linux' })).not.toBe(uriKey(nfd, { platform: 'linux' }));
  });

  it('canonicalizes URL encoding without turning encoded slashes into separators', () => {
    expect(uriKey('file:///Project/%41%2fb.shader', { platform: 'linux' })).toBe(
      'file:///Project/A%2Fb.shader',
    );
    expect(uriKey('untitled:Shader-1', { platform: 'darwin' })).toBe('untitled:Shader-1');
    expect(uriKey('not a uri', { platform: 'darwin' })).toBe('not a uri');
  });

  it('uses the same platform normalization as filesystem path identity', () => {
    const cases = [
      { path: '/Users/CAFE\u0301/Main.shader', platform: 'darwin' as const },
      { path: '/Project/Mixed/Main.shader', platform: 'linux' as const },
      { path: 'C:/Unity/Mixed/Main.shader', platform: 'win32' as const },
    ];

    for (const entry of cases) {
      const uri = entry.platform === 'win32'
        ? `file:///${entry.path}`
        : pathToFileURL(entry.path).href;
      const uriPath = new URL(uriKey(uri, { platform: entry.platform })).pathname
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      const comparableUriPath = entry.platform === 'win32' ? uriPath.slice(1) : uriPath;

      expect(comparableUriPath).toBe(
        normalizePathForComparison(entry.path, { platform: entry.platform }),
      );
    }
  });
});
