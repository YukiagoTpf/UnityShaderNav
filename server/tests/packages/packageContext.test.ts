import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { PackageContext } from '../../src/packages';

describe('PackageContext.standalone', () => {
  it('has no resolver', () => {
    const ctx = PackageContext.standalone(DEFAULT_SETTINGS);

    expect(ctx.hasResolver()).toBe(false);
  });

  it('reports nothing is in packages', () => {
    const ctx = PackageContext.standalone(DEFAULT_SETTINGS);

    expect(ctx.isInPackages('file:///anything.hlsl')).toBe(false);
  });

  it('derives includeCtx from settings only', () => {
    const ctx = PackageContext.standalone(DEFAULT_SETTINGS);

    expect(ctx.includeCtx).toEqual({
      unityProjectRoot: undefined,
      includeDirectories: DEFAULT_SETTINGS.includeDirectories,
    });
    expect(ctx.includeCtx.packagePhysicalPaths).toBeUndefined();
  });

  it('exposes no package roots', () => {
    const ctx = PackageContext.standalone(DEFAULT_SETTINGS);

    expect(ctx.packageRoots()).toEqual([]);
  });
});

describe('PackageContext.load', () => {
  const projectA = resolve(__dirname, '../include/fixtures/projectA');

  it('has a resolver', async () => {
    const ctx = await PackageContext.load(projectA, DEFAULT_SETTINGS);

    expect(ctx.hasResolver()).toBe(true);
  });

  it('exposes at least one package root', async () => {
    const ctx = await PackageContext.load(projectA, DEFAULT_SETTINGS);

    expect(ctx.packageRoots().length).toBeGreaterThanOrEqual(1);
  });

  it('derives includeCtx.packagePhysicalPaths as a non-empty Map', async () => {
    const ctx = await PackageContext.load(projectA, DEFAULT_SETTINGS);

    expect(ctx.includeCtx.packagePhysicalPaths).toBeInstanceOf(Map);
    expect(ctx.includeCtx.packagePhysicalPaths!.size).toBeGreaterThanOrEqual(1);
  });

  it('reports a file under a package root as in packages', async () => {
    const ctx = await PackageContext.load(projectA, DEFAULT_SETTINGS);

    const packageUri = pathToFileURL(
      join(projectA, 'Packages', 'com.example.urp', 'ShaderLibrary', 'Core.hlsl'),
    ).href;

    expect(ctx.isInPackages(packageUri)).toBe(true);
  });

  it('reports a user asset file as not in packages', async () => {
    const ctx = await PackageContext.load(projectA, DEFAULT_SETTINGS);

    const userUri = pathToFileURL(join(projectA, 'Assets', 'Shaders', 'Main.shader')).href;

    expect(ctx.isInPackages(userUri)).toBe(false);
  });
});
