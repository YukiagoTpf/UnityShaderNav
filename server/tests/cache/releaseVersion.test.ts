import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseVersionForModule } from '../../src/cache/releaseVersion';
import type {
  ParserRuntimeAssets,
  ParserRuntimeLayout,
} from '../../src/parser/runtimeAssets';

function runtimeAssets(layout: ParserRuntimeLayout): ParserRuntimeAssets {
  return { layout, runtimeRoot: '/development/runtime' } as ParserRuntimeAssets;
}

describe('releaseVersionForModule', () => {
  it.each<ParserRuntimeLayout>(['source', 'tsc-out', 'copied-server'])(
    'disables persistent cache identity for the %s development layout',
    (layout) => {
      expect(releaseVersionForModule('/development/server.js', runtimeAssets(layout)))
        .toBeUndefined();
    },
  );

  it.each([
    '2.3.4',
    '1.2.3-beta.1+build.7',
  ])('reads bundled extension release version %s', async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'usn-release-version-'));
    const runtimeRoot = join(root, 'out', 'server');
    const moduleFile = join(runtimeRoot, 'server.js');
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ version }));

      expect(releaseVersionForModule(moduleFile, {
        ...runtimeAssets('bundled-server'),
        runtimeRoot,
      })).toBe(version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed bundled extension version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-release-version-invalid-'));
    const runtimeRoot = join(root, 'out', 'server');
    const moduleFile = join(runtimeRoot, 'server.js');
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        version: '1.2.3-beta+build+again',
      }));

      expect(releaseVersionForModule(moduleFile, {
        ...runtimeAssets('bundled-server'),
        runtimeRoot,
      })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
