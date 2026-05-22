import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PackageResolver } from '../../src/packages';

async function makeFakeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usn-'));
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await mkdir(join(root, 'Library', 'PackageCache'), { recursive: true });

  await writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
    dependencies: {
      'com.unity.render-pipelines.universal': {
        version: '14.0.10',
        source: 'registry',
        hash: 'abc',
      },
      'com.example.embedded': {
        version: 'file:com.example.embedded',
        source: 'embedded',
      },
      'com.unity.builtin': {
        version: '1.0.0',
        source: 'builtin',
      },
    },
  }));

  await mkdir(join(root, 'Packages', 'com.example.embedded'), { recursive: true });
  await mkdir(join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@abc'), {
    recursive: true,
  });

  return root;
}

describe('PackageResolver', () => {
  it('builds map after load()', async () => {
    const root = await makeFakeProject();
    const resolver = new PackageResolver(root);

    await resolver.load();

    expect(resolver.getPath('com.unity.render-pipelines.universal'))
      .toBe(join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@abc'));
    expect(resolver.getPath('com.example.embedded'))
      .toBe(join(root, 'Packages', 'com.example.embedded'));
    expect(resolver.getPath('com.unity.builtin')).toBeUndefined();
    expect(resolver.getPath('com.unknown')).toBeUndefined();
  });

  it('returns empty when packages-lock.json missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-empty-'));
    const resolver = new PackageResolver(root);

    await resolver.load();

    expect(resolver.allPaths()).toEqual([]);
  });

  it('resolveIncludePath maps Packages/<name>/... to absolute path', async () => {
    const root = await makeFakeProject();
    const resolver = new PackageResolver(root);
    await resolver.load();

    expect(resolver.resolveIncludePath('Packages/com.example.embedded/Foo.hlsl'))
      .toBe(join(root, 'Packages', 'com.example.embedded', 'Foo.hlsl'));
  });
});
