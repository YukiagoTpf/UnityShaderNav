import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentationResolver } from '../../src/documentation';
import { PackageContext } from '../../src/packages';
import { UnityProjectFacts } from '../../src/project';
import { findBuiltinEntries } from '../../src/vocabulary';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function context(
  version: string,
  source = 'registry',
  scopedRegistries: readonly string[] = [],
): Promise<{
  packages: PackageContext;
  packageUri: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'usn-docs-'));
  roots.push(root);
  const packageName = 'com.unity.render-pipelines.universal';
  const packageRoot = source === 'local'
    ? join(root, 'External', packageName)
    : join(root, 'Library', 'PackageCache', `${packageName}@hash`);
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
    dependencies: {
      [packageName]: source === 'local'
        ? { version: `file:../External/${packageName}`, source }
        : { version, source, hash: 'hash' },
    },
  }));
  await writeFile(join(root, 'Packages', 'manifest.json'), JSON.stringify({
    dependencies: { [packageName]: version },
    scopedRegistries: scopedRegistries.length > 0
      ? [{ name: 'custom', url: 'https://registry.example.test', scopes: scopedRegistries }]
      : [],
  }));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version,
  }));
  const packages = await PackageContext.load(root, DEFAULT_SETTINGS);
  return {
    packages,
    packageUri: pathToFileURL(join(packageRoot, 'ShaderLibrary', 'Core.hlsl')).href,
  };
}

describe('DocumentationResolver', () => {
  it('accepts a visible compatible registry package and carries exact provenance', async () => {
    const { packages, packageUri } = await context('17.0.3');
    const resolver = new DocumentationResolver(packages, UnityProjectFacts.unknown());
    const entries = findBuiltinEntries('GetVertexPositionInputs');

    expect(resolver.curated(entries, new Set([packageUri]))).toEqual([
      expect.objectContaining({
        package: {
          name: 'com.unity.render-pipelines.universal',
          version: '17.0.3',
          source: 'registry',
        },
      }),
    ]);
  });

  it('stays neutral for invisible, incompatible, or locally modified packages', async () => {
    const compatible = await context('17.0.3');
    const incompatible = await context('16.0.6');
    const local = await context('17.0.3', 'local');
    const customRegistry = await context('17.0.3', 'registry', ['com.unity']);
    const entries = findBuiltinEntries('GetVertexPositionInputs');

    expect(new DocumentationResolver(
      compatible.packages,
      UnityProjectFacts.unknown(),
    ).curated(entries, new Set())).toEqual([]);
    expect(new DocumentationResolver(incompatible.packages, UnityProjectFacts.unknown()).curated(
      entries,
      new Set([incompatible.packageUri]),
    )).toEqual([]);
    expect(new DocumentationResolver(local.packages, UnityProjectFacts.unknown()).curated(
      entries,
      new Set([local.packageUri]),
    )).toEqual([]);
    expect(new DocumentationResolver(
      customRegistry.packages,
      UnityProjectFacts.unknown(),
    ).curated(entries, new Set([customRegistry.packageUri]))).toEqual([]);
  });

  it('gates Unity documentation by the captured editor major/minor version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-unity-facts-'));
    roots.push(root);
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    const versionPath = join(root, 'ProjectSettings', 'ProjectVersion.txt');
    const packages = PackageContext.standalone(DEFAULT_SETTINGS);
    const entries = findBuiltinEntries('Cull');

    await writeFile(versionPath, 'm_EditorVersion: 2022.3.53f1\n');
    const supported = await UnityProjectFacts.load(root);
    expect(new DocumentationResolver(packages, supported).curated(entries, new Set())).toHaveLength(1);

    await writeFile(versionPath, 'm_EditorVersion: 2021.3.45f1\n');
    const incompatible = await UnityProjectFacts.load(root);
    expect(new DocumentationResolver(packages, incompatible).curated(entries, new Set())).toEqual([]);
    expect(new DocumentationResolver(
      packages,
      UnityProjectFacts.unknown(),
    ).curated(entries, new Set())).toEqual([]);
  });
});
