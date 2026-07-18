import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parsePackagesLock, resolvePackagePhysicalPath } from '../../src/packages/lockfile';

const fixtures = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures/packages-lock-samples', name), 'utf8');

describe('parsePackagesLock', () => {
  it('extracts dependency entries with source/version', () => {
    const data = parsePackagesLock(fixtures('embedded.json')).entries;

    expect(data['com.example.urp'].source).toBe('embedded');
    expect(data['com.unity.render-pipelines.core'].source).toBe('builtin');
    expect(data['com.example.urp'].version).toBe('file:com.example.urp');
  });

  it('extracts git+ssh dependency entries with source, version and hash', () => {
    const data = parsePackagesLock(fixtures('git-ssh.json')).entries;

    expect(data['com.example.priv'].source).toBe('git');
    expect(data['com.example.priv'].version).toBe('git+ssh://git@example.com/foo.git');
    expect(data['com.example.priv'].hash).toBe('feedface');
  });

  it('rejects malformed JSON', () => {
    expect(() => parsePackagesLock('{broken json')).toThrow(SyntaxError);
  });

  it.each([
    ['a non-object root', '[]', /top-level object/],
    ['missing dependencies', '{}', /missing dependencies object/],
    ['non-object dependencies', '{"dependencies":[]}', /dependencies must be an object/],
  ])('rejects structurally invalid lockfile: %s', (_name, content, expected) => {
    expect(() => parsePackagesLock(content)).toThrow(expected);
  });

  it.each([
    [
      'non-object dependency entry',
      '{"dependencies":{"com.example.bad":null}}',
      /must be an object/,
    ],
    [
      'missing dependency version',
      '{"dependencies":{"com.example.bad":{"source":"registry"}}}',
      /must have a string version/,
    ],
    [
      'git dependency without a hash',
      '{"dependencies":{"com.example.bad":{"source":"git","version":"https://example.com/repo.git"}}}',
      /with source git must have a non-empty hash/,
    ],
    [
      'embedded dependency without a file version',
      '{"dependencies":{"com.example.bad":{"source":"embedded","version":"1.0.0"}}}',
      /with source embedded must have a non-empty file: version/,
    ],
    [
      'local dependency with an empty file version',
      '{"dependencies":{"com.example.bad":{"source":"local","version":"file:"}}}',
      /with source local must have a non-empty file: version/,
    ],
    [
      'embedded dependency with a whitespace-only file target',
      '{"dependencies":{"com.example.bad":{"source":"embedded","version":"file:   "}}}',
      /with source embedded must have a non-empty file: version/,
    ],
    [
      'builtin dependency with an empty version',
      '{"dependencies":{"com.example.bad":{"source":"builtin","version":""}}}',
      /with source builtin must have a non-empty version/,
    ],
    [
      'registry dependency with surrounding version whitespace',
      '{"dependencies":{"com.example.bad":{"source":"registry","version":" 1.0.0 "}}}',
      /without surrounding whitespace/,
    ],
    [
      'git dependency with a whitespace-only hash',
      '{"dependencies":{"com.example.bad":{"source":"git","version":"https://example.com/repo.git","hash":"   "}}}',
      /non-empty hash/,
    ],
    [
      'blank dependency source',
      '{"dependencies":{"com.example.bad":{"source":"   ","version":"1.0.0"}}}',
      /non-empty source without surrounding whitespace/,
    ],
    [
      'known dependency source padded with whitespace',
      '{"dependencies":{"com.example.bad":{"source":" registry ","version":"1.0.0"}}}',
      /source without surrounding whitespace/,
    ],
  ])('skips %s and reports one named diagnostic', (_name, content, expected) => {
    const input = JSON.parse(content) as {
      dependencies: Record<string, unknown>;
    };
    input.dependencies['com.example.valid'] = {
      source: 'registry',
      version: '1.2.3',
    };
    const parsed = parsePackagesLock(JSON.stringify(input));

    expect(parsed.entries).toEqual({
      'com.example.valid': { source: 'registry', version: '1.2.3' },
    });
    expect(parsed.malformedEntries).toEqual([{
      name: 'com.example.bad',
      reason: expect.stringMatching(expected),
    }]);
  });
});

describe('resolvePackagePhysicalPath', () => {
  const projectRoot = resolve('/proj');

  it('embedded maps to Packages/<dir>', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.urp',
      { version: 'file:com.example.urp', source: 'embedded' },
      projectRoot,
    )).toBe(join(projectRoot, 'Packages', 'com.example.urp'));
  });

  it('builtin maps to Library/PackageCache/<name>@<version>', () => {
    expect(resolvePackagePhysicalPath(
      'com.unity.render-pipelines.core',
      { version: '12.1.7', source: 'builtin' },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.unity.render-pipelines.core@12.1.7'));
  });

  it('registry with hash maps to Library/PackageCache/<name>@<hash>', () => {
    expect(resolvePackagePhysicalPath(
      'com.unity.render-pipelines.universal',
      { version: '14.0.10', source: 'registry', hash: 'abc123' },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.unity.render-pipelines.universal@abc123'));
  });

  it('registry without hash falls back to Library/PackageCache/<name>@<version>', () => {
    expect(resolvePackagePhysicalPath(
      'com.unity.foo',
      { version: '1.0.0', source: 'registry' },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.unity.foo@1.0.0'));
  });

  it('git with hash maps to Library/PackageCache/<name>@<hash>', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.myrp',
      { version: 'git+https://example.com', source: 'git', hash: 'deadbeef' },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.example.myrp@deadbeef'));
  });

  it('git without hash returns null', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.myrp',
      { version: 'git+https://example.com', source: 'git' },
      projectRoot,
    )).toBeNull();
  });

  it('git with ?path= subdir maps to Library/PackageCache/<name>@<hash[:10]>', () => {
    // Unity extracts only the subdir into the cache folder; the directory name
    // itself does not encode the subpath. Verified against Unity 2022.3 lockfiles.
    expect(resolvePackagePhysicalPath(
      'com.cysharp.unitask',
      {
        version: 'https://github.com/Cysharp/UniTask.git?path=src/UniTask/Assets/Plugins/UniTask#2.5.5',
        source: 'git',
        hash: 'cdf88c6a6ac8c9b7e6e5d3c0a360a4af29641c24',
      },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.cysharp.unitask@cdf88c6a6a'));
  });

  it('git with a real 40-char hash truncates the cache directory hash to 10 chars', () => {
    // Verified against Unity 2022.3 lockfiles. Existing short-hash fixtures
    // happened to pass because `slice(0, 10)` is a no-op on strings of length ≤10.
    expect(resolvePackagePhysicalPath(
      'com.unity.test-framework',
      {
        version: 'https://github.com/needle-mirror/com.unity.test-framework.git#1.1.33',
        source: 'git',
        hash: '07e70135879aba310eac100ad9c43c356160107e',
      },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.unity.test-framework@07e7013587'));
  });

  it('git+ssh with hash maps to Library/PackageCache/<name>@<hash>', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.priv',
      { version: 'git+ssh://git@example.com/foo.git', source: 'git', hash: 'feedface' },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.example.priv@feedface'));
  });

  it('git+http (no s) with hash maps to Library/PackageCache/<name>@<hash>', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.insecure',
      { version: 'git+http://example.com/foo.git', source: 'git', hash: 'cafebabe' },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.example.insecure@cafebabe'));
  });

  it('git+ssh with ?path= subdir resolves the same way as https', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.priv-mono',
      { version: 'git+ssh://git@example.com/foo.git?path=packages/bar', source: 'git', hash: 'abc' },
      projectRoot,
    )).toBe(join(projectRoot, 'Library', 'PackageCache', 'com.example.priv-mono@abc'));
  });

  it('local relative file paths resolve relative to Packages/', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.local',
      { version: 'file:../shared-rp', source: 'local' },
      projectRoot,
    )).toBe(resolve(join(projectRoot, 'Packages'), '../shared-rp'));
  });

  it('local absolute file paths are returned as-is', () => {
    const abs = isAbsolute('/workspace/rp') ? '/workspace/rp' : resolve('C:/rp');

    expect(resolvePackagePhysicalPath(
      'com.example.abs',
      { version: `file:${abs}`, source: 'local' },
      projectRoot,
    )).toBe(abs);
  });

  it('unknown source returns null', () => {
    expect(resolvePackagePhysicalPath(
      'com.weird',
      { version: '1.0.0', source: 'something-new' },
      projectRoot,
    )).toBeNull();
  });
});
