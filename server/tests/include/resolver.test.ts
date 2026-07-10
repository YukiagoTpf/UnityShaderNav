import { describe, expect, it } from 'vitest';
import { join, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInclude } from '../../src/include/resolver';
import type { IncludeContext } from '../../src/include/types';

const fixtureRoot = pathResolve(__dirname, 'fixtures/projectA');
const caseRoot = pathResolve(__dirname, 'fixtures/caseSensitivity');

function ctx(): IncludeContext {
  return { unityProjectRoot: fixtureRoot, includeDirectories: [] };
}

describe('resolveInclude: relative path wins', () => {
  it('resolves "Common.hlsl" from a file in the same directory', async () => {
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const result = await resolveInclude('Common.hlsl', fromUri, ctx());

    expect(result?.via).toBe('relative');
    expect(result?.absolutePath).toBe(join(fixtureRoot, 'Assets/Shaders/Common.hlsl'));
  });

  it('resolves "Inner/Lighting.hlsl" relative', async () => {
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const result = await resolveInclude('Inner/Lighting.hlsl', fromUri, ctx());

    expect(result?.absolutePath).toBe(join(fixtureRoot, 'Assets/Shaders/Inner/Lighting.hlsl'));
  });
});

describe('resolveInclude: Assets fallback', () => {
  it('falls back to projectRoot/Assets when not relative', async () => {
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const result = await resolveInclude('CustomCG/MyHelper.hlsl', fromUri, ctx());

    expect(result?.via).toBe('assets');
    expect(result?.absolutePath.endsWith(join('Assets', 'CustomCG', 'MyHelper.hlsl'))).toBe(true);
  });
});

describe('resolveInclude: includeDirectories', () => {
  it('finds via user-configured directory', async () => {
    const extra = join(fixtureRoot, 'Assets/CustomCG');
    const includeCtx: IncludeContext = {
      unityProjectRoot: undefined,
      includeDirectories: [extra],
    };
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const result = await resolveInclude('MyHelper.hlsl', fromUri, includeCtx);

    expect(result?.via).toBe('includeDirectories');
    expect(result?.absolutePath.endsWith('MyHelper.hlsl')).toBe(true);
  });

  it('returns null when nothing matches', async () => {
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;
    const result = await resolveInclude('does/not/exist.hlsl', fromUri, ctx());

    expect(result).toBeNull();
  });
});

describe('resolveInclude: Packages/...', () => {
  it('resolves via package physical path map', async () => {
    const physicalPath = join(fixtureRoot, 'Packages', 'com.example.urp');
    const includeCtx: IncludeContext = {
      unityProjectRoot: fixtureRoot,
      includeDirectories: [],
      packagePhysicalPaths: new Map([['com.example.urp', physicalPath]]),
    };
    const fromUri = pathToFileURL(join(fixtureRoot, 'Assets/Shaders/Main.shader')).href;

    const result = await resolveInclude(
      'Packages/com.example.urp/ShaderLibrary/Core.hlsl',
      fromUri,
      includeCtx,
    );

    expect(result?.via).toBe('package');
    expect(result?.absolutePath).toBe(join(physicalPath, 'ShaderLibrary', 'Core.hlsl'));
  });
});

describe('resolveInclude: case-insensitive fallback', () => {
  it('returns the file via case-insensitive match with warning flag', async () => {
    const fromUri = pathToFileURL(join(caseRoot, 'Assets/Shaders/Main.hlsl')).href;
    const includeCtx: IncludeContext = { unityProjectRoot: caseRoot, includeDirectories: [] };
    const result = await resolveInclude('Helper.hlsl', fromUri, includeCtx);

    expect(result).not.toBeNull();
    expect(result?.caseInsensitive).toBe(true);
    expect(result?.absolutePath.endsWith(join('Assets', 'Shaders', 'helper.hlsl'))).toBe(true);
  });
});
