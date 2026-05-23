import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import { containsPath, normalizePathForComparison } from '../../src/workspace/pathUtils';

describe('workspace pathUtils', () => {
  it('normalizes Windows paths case-insensitively for comparison', () => {
    expect(normalizePathForComparison('C:\\Unity\\Project\\Assets', { platform: 'win32' }))
      .toBe('c:\\unity\\project\\assets');
    expect(normalizePathForComparison('/Unity/Project/Assets', { platform: 'linux' }))
      .toBe('/Unity/Project/Assets');
  });

  it('contains Windows paths with different casing', () => {
    const options = { path: win32, platform: 'win32' as const };

    expect(containsPath('C:\\Unity\\Project', 'c:\\unity\\project\\Assets\\Main.shader', options))
      .toBe(true);
    expect(containsPath('C:\\Unity\\Project', 'C:\\Unity\\Project\\..cache\\File.hlsl', options))
      .toBe(true);
    expect(containsPath('C:\\Unity\\Project', 'C:\\Unity\\Project\\..\\Other\\File.hlsl', options))
      .toBe(false);
    expect(containsPath('C:\\Unity\\Project', 'C:\\Unity\\ProjectSibling\\Main.shader', options))
      .toBe(false);
    expect(containsPath('C:\\Unity\\Project', 'D:\\Unity\\Project\\Main.shader', options))
      .toBe(false);
  });

  it('keeps POSIX path containment case-sensitive', () => {
    const options = { path: posix, platform: 'linux' as const };

    expect(containsPath('/Unity/Project', '/Unity/Project/Assets/Main.shader', options))
      .toBe(true);
    expect(containsPath('/Unity/Project', '/Unity/Project/..generated/file.hlsl', options))
      .toBe(true);
    expect(containsPath('/Unity/Project', '/Unity/Project/../Other/file.hlsl', options))
      .toBe(false);
    expect(containsPath('/Unity/Project', '/unity/project/Assets/Main.shader', options))
      .toBe(false);
  });
});
