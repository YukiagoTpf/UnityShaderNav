import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parsePackagesLock, resolvePackagePhysicalPath } from '../../src/packages/lockfile';

const fixtures = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures/packages-lock-samples', name), 'utf8');

describe('parsePackagesLock', () => {
  it('extracts dependency entries with source/version', () => {
    const data = parsePackagesLock(fixtures('embedded.json'));

    expect(data['com.example.urp'].source).toBe('embedded');
    expect(data['com.unity.render-pipelines.core'].source).toBe('builtin');
    expect(data['com.example.urp'].version).toBe('file:com.example.urp');
  });

  it('extracts git+ssh dependency entries with source, version and hash', () => {
    const data = parsePackagesLock(fixtures('git-ssh.json'));

    expect(data['com.example.priv'].source).toBe('git');
    expect(data['com.example.priv'].version).toBe('git+ssh://git@example.com/foo.git');
    expect(data['com.example.priv'].hash).toBe('feedface');
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
    // itself does not encode the subpath. Verified against Unity 2022.3 (issue #25).
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
    // Verified against Unity 2022.3 (issue #25). Existing short-hash fixtures
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
    const abs = isAbsolute('/Users/me/rp') ? '/Users/me/rp' : resolve('C:/rp');

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
