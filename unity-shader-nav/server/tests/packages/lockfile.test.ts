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

  it('git with path subdir returns null', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.mono',
      { version: 'git+https://example.com#main?path=packages/foo', source: 'git', hash: 'abc' },
      projectRoot,
    )).toBeNull();
  });

  it('git+ssh returns null', () => {
    expect(resolvePackagePhysicalPath(
      'com.example.priv',
      { version: 'git+ssh://git@example.com/foo.git', source: 'git', hash: 'abc' },
      projectRoot,
    )).toBeNull();
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
