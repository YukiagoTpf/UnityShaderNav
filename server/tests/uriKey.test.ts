import { describe, expect, it } from 'vitest';
import { sourceNameMatchesUri } from '@unity-shader-nav/shared';
import { normalizePathForComparison } from '../src/pathIdentity';
import { uriKey } from '../src/uriKey';

describe('uriKey', () => {
  it('normalizes macOS case and Unicode composition before re-encoding', () => {
    const nfc = 'file:///project/Caf%C3%A9/%C3%89clair.shader';
    const nfd = 'file:///PROJECT/CAFE%CC%81/E%CC%81CLAIR.shader';

    expect(uriKey(nfc, { platform: 'darwin' })).toBe(
      'file:///project/caf%C3%A9/%C3%A9clair.shader',
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
    const nfc = 'file:///Project/Caf%C3%A9/Main.shader';
    const nfd = 'file:///project/Cafe%CC%81/Main.shader';

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
      {
        path: '/project/CAFE\u0301/Main.shader',
        uri: 'file:///project/CAFE%CC%81/Main.shader',
        platform: 'darwin' as const,
      },
      {
        path: '/Project/Mixed/Main.shader',
        uri: 'file:///Project/Mixed/Main.shader',
        platform: 'linux' as const,
      },
      {
        path: 'C:/Unity/Mixed/Main.shader',
        uri: 'file:///C:/Unity/Mixed/Main.shader',
        platform: 'win32' as const,
      },
    ];

    for (const entry of cases) {
      const uriPath = new URL(uriKey(entry.uri, { platform: entry.platform })).pathname
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      const comparableUriPath = entry.platform === 'win32' ? uriPath.slice(1) : uriPath;

      expect(comparableUriPath).toBe(
        normalizePathForComparison(entry.path, { platform: entry.platform }),
      );
    }
  });

  it('binds compiler source aliases to a mapped file URI suffix', () => {
    const uri = 'file:///Project/Assets/Shaders/Ship.shader';
    expect(sourceNameMatchesUri(
      uri,
      'Assets/Shaders/Ship.shader',
      { platform: 'linux' },
    )).toBe(true);
    expect(sourceNameMatchesUri(
      uri,
      'Ship.shader',
      { platform: 'linux' },
    )).toBe(true);
    expect(sourceNameMatchesUri(
      uri,
      'assets/shaders/ship.shader',
      { platform: 'darwin' },
    )).toBe(true);
    expect(sourceNameMatchesUri(
      'file:///C:/Unity/Assets/Shaders/Ship.shader',
      'c:\\unity\\assets\\shaders\\SHIP.shader',
      { platform: 'linux' },
    )).toBe(true);
    expect(sourceNameMatchesUri(
      uri,
      'Other/Forged.shader',
      { platform: 'linux' },
    )).toBe(false);
    expect(sourceNameMatchesUri(
      uri,
      '../Shaders/Ship.shader',
      { platform: 'linux' },
    )).toBe(false);
  });

  it('treats a percent sign in a plain compiler source name as data', () => {
    // A `#line` directive reports a raw filesystem spelling, so '%' is part of
    // the filename. Decoding it threw URIError on the first case and silently
    // rewrote the second, collapsing correct evidence to invalid-evidence.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(sourceNameMatchesUri(
        'file:///Project/Assets/Shaders/50%25Blend.hlsl',
        'Assets/Shaders/50%Blend.hlsl',
        { platform },
      )).toBe(true);
      expect(sourceNameMatchesUri(
        'file:///Project/Assets/A%2520B.hlsl',
        'Assets/A%20B.hlsl',
        { platform },
      )).toBe(true);
    }
    // A literal '%20' name must not match the file whose name is 'A B.hlsl'.
    expect(sourceNameMatchesUri(
      'file:///Project/Assets/A%20B.hlsl',
      'Assets/A%20B.hlsl',
      { platform: 'linux' },
    )).toBe(false);
  });

  it('still decodes percent-encoded segments of a file: URL source name', () => {
    expect(sourceNameMatchesUri(
      'file:///Project/Assets/A%20B.hlsl',
      'file:///Project/Assets/A%20B.hlsl',
      { platform: 'linux' },
    )).toBe(true);
    expect(sourceNameMatchesUri(
      'file:///Project/Assets/Shaders/50%25Blend.hlsl',
      'file:///Project/Assets/Shaders/50%25Blend.hlsl',
      { platform: 'linux' },
    )).toBe(true);
  });
});
