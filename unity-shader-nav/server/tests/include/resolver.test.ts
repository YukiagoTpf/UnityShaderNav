import { describe, expect, it } from 'vitest';
import { join, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveInclude } from '../../src/include/resolver';
import type { IncludeContext } from '../../src/include/types';

const fixtureRoot = pathResolve(__dirname, 'fixtures/projectA');

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
