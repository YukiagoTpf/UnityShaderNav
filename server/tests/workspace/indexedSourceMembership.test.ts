import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { IndexedSourceMembership } from '../../src/workspace/indexedSourceMembership';

function uri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

describe('IndexedSourceMembership', () => {
  it('defines standalone admission from the workspace folder and configured excludes', () => {
    const root = join(tmpdir(), 'standalone-membership');
    const membership = IndexedSourceMembership.create({
      folderUri: uri(root),
      settings: DEFAULT_SETTINGS,
      unityRoot: undefined,
      packages: { packageRoots: () => [] },
    });

    expect(membership.containsUri(uri(join(root, 'Standalone.hlsl')))).toBe(true);
    expect(membership.containsUri(uri(join(root, 'Library', 'Ignored.hlsl')))).toBe(false);
    expect(membership.containsUri(uri(join(root, 'Notes.txt')))).toBe(false);
    expect(membership.containsUri(uri(join(root, '..', 'Outside.hlsl')))).toBe(false);
  });

  it('discovers shader files within the workspace folder in standalone mode', async () => {
    const base = await mkdtemp(join(tmpdir(), 'standalone-discover-'));
    const root = join(base, 'project');
    const files = {
      shader: join(root, 'Assets', 'Main.shader'),
      hlsl: join(root, 'Assets', 'Include.hlsl'),
      excluded: join(root, 'Library', 'Ignored.hlsl'),
      nonShader: join(root, 'Assets', 'Readme.md'),
    };
    try {
      await Promise.all(Object.values(files).map(async (filePath) => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, 'float4 Example() { return 0; }');
      }));
      const membership = IndexedSourceMembership.create({
        folderUri: uri(root),
        settings: DEFAULT_SETTINGS,
        unityRoot: undefined,
        packages: { packageRoots: () => [] },
      });

      const discovered = await membership.discover(new AbortController().signal);

      expect(discovered.userFiles).toEqual([files.hlsl, files.shader].sort());
      expect(discovered.packageFiles).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('admits only user sources and currently resolved package sources in Unity mode', () => {
    const root = join(tmpdir(), 'unity-membership');
    const externalPackage = join(tmpdir(), 'external-package');
    const embeddedPackage = join(root, 'Packages', 'com.example.embedded');
    const membership = IndexedSourceMembership.create({
      folderUri: uri(root),
      settings: {
        ...DEFAULT_SETTINGS,
        excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, '**/Generated/**'],
      },
      unityRoot: root,
      packages: { packageRoots: () => [embeddedPackage, externalPackage] },
    });

    const cases: ReadonlyArray<readonly [string, boolean]> = [
      [join(root, 'Assets', 'Main.shader'), true],
      [join(root, 'Assets', 'Generated', 'Ignored.hlsl'), false],
      [join(embeddedPackage, 'Runtime', 'Embedded.hlsl'), true],
      [join(externalPackage, 'Runtime', 'External.cginc'), true],
      [join(embeddedPackage, 'Documentation~', 'Example.hlsl'), false],
      [join(externalPackage, 'Samples~', 'Example.shader'), false],
      [join(root, 'Packages', 'com.example.unlisted', 'Hidden.hlsl'), false],
      [join(root, 'Library', 'PackageCache', 'com.example.unlisted', 'Hidden.hlsl'), false],
      [join(root, 'Assets', 'Readme.md'), false],
    ];
    for (const [filePath, expected] of cases) {
      expect(membership.containsUri(uri(filePath)), filePath).toBe(expected);
    }
  });

  it('discovers exactly the same user and package members admitted by the policy', async () => {
    const base = await mkdtemp(join(tmpdir(), 'indexed-membership-'));
    const root = join(base, 'project');
    const embeddedPackage = join(root, 'Packages', 'com.example.embedded');
    const externalPackage = join(base, 'external-package');
    const files = {
      user: join(root, 'Assets', 'Main.shader'),
      generated: join(root, 'Assets', 'Generated', 'Ignored.hlsl'),
      embedded: join(embeddedPackage, 'Runtime', 'Embedded.hlsl'),
      embeddedDocs: join(embeddedPackage, 'Documentation~', 'Ignored.hlsl'),
      external: join(externalPackage, 'Runtime', 'External.cginc'),
      externalSamples: join(externalPackage, 'Samples~', 'Ignored.shader'),
      unlisted: join(root, 'Packages', 'com.example.unlisted', 'Hidden.hlsl'),
    };
    try {
      await Promise.all(Object.values(files).map(async (filePath) => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, 'float4 Example() { return 0; }');
      }));
      const membership = IndexedSourceMembership.create({
        folderUri: uri(root),
        settings: {
          ...DEFAULT_SETTINGS,
          excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, '**/Generated/**'],
        },
        unityRoot: root,
        packages: { packageRoots: () => [embeddedPackage, externalPackage] },
      });

      const discovered = await membership.discover(new AbortController().signal);

      expect(discovered.userFiles).toEqual([files.user]);
      expect(discovered.packageFiles).toEqual([files.external, files.embedded].sort());
      for (const filePath of [...discovered.userFiles, ...discovered.packageFiles]) {
        expect(membership.containsUri(uri(filePath)), filePath).toBe(true);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('uses the same deepest-root classification for overlapping discovery roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'overlapping-membership-'));
    const root = join(base, 'project');
    const localPackage = join(root, 'Assets', 'LocalPackage');
    const outerPackage = join(base, 'outer-package');
    const nestedPackage = join(outerPackage, 'Samples~', 'NestedPackage');
    const files = {
      localRuntime: join(localPackage, 'Runtime', 'Local.hlsl'),
      localDocs: join(localPackage, 'Documentation~', 'Ignored.hlsl'),
      outerRuntime: join(outerPackage, 'Runtime', 'Outer.hlsl'),
      nestedRuntime: join(nestedPackage, 'Runtime', 'Nested.hlsl'),
    };
    try {
      await Promise.all(Object.values(files).map(async (filePath) => {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, 'float4 Example() { return 0; }');
      }));
      const membership = IndexedSourceMembership.create({
        folderUri: uri(root),
        settings: DEFAULT_SETTINGS,
        unityRoot: root,
        packages: {
          packageRoots: () => [outerPackage, nestedPackage, localPackage],
        },
      });

      const discovered = await membership.discover(new AbortController().signal);

      expect(discovered.userFiles).toEqual([]);
      expect(discovered.packageFiles).toEqual([
        files.localRuntime,
        files.nestedRuntime,
        files.outerRuntime,
      ].sort());
      expect(membership.containsUri(uri(files.localDocs))).toBe(false);
      for (const filePath of discovered.packageFiles) {
        expect(membership.containsUri(uri(filePath)), filePath).toBe(true);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
