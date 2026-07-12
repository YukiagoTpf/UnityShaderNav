import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  await mkdir(join(root, 'Library', 'PackageCache', 'com.unity.builtin@1.0.0'), {
    recursive: true,
  });

  return root;
}

describe('PackageResolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds map after load()', async () => {
    const root = await makeFakeProject();
    const resolver = new PackageResolver(root);

    await resolver.load();

    expect(resolver.getPath('com.unity.render-pipelines.universal'))
      .toBe(join(root, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@abc'));
    expect(resolver.getPath('com.example.embedded'))
      .toBe(join(root, 'Packages', 'com.example.embedded'));
    expect(resolver.getPath('com.unity.builtin'))
      .toBe(join(root, 'Library', 'PackageCache', 'com.unity.builtin@1.0.0'));
    expect(resolver.getPath('com.unknown')).toBeUndefined();
  });

  it('reports actionable context when packages-lock.json is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-empty-'));
    const resolver = new PackageResolver(root);

    await expect(resolver.load()).rejects.toThrow(
      'Unable to read Packages/packages-lock.json (ENOENT).',
    );
  });

  it('rejects incomplete fields for a recognized package source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-invalid-package-'));
    await mkdir(join(root, 'Packages'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), JSON.stringify({
      dependencies: {
        'com.example.git': {
          source: 'git',
          version: 'https://example.com/repo.git',
        },
      },
    }));
    const resolver = new PackageResolver(root);

    await expect(resolver.load()).rejects.toThrow(
      /Invalid Packages\/packages-lock\.json: dependency com\.example\.git .*non-empty hash/,
    );
  });

  it('skips unknown source entries and warns instead of guessing a path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-unknown-'));
    await mkdir(join(root, 'Packages'), { recursive: true });
    await copyFile(
      join(__dirname, 'fixtures/packages-lock-samples/unknown-source.json'),
      join(root, 'Packages', 'packages-lock.json'),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resolver = new PackageResolver(root);
    await resolver.load();

    expect(resolver.getPath('com.example.future')).toBeUndefined();
    expect(resolver.allPaths()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain('com.example.future');
    expect(message).toContain('something-new');
  });
});
