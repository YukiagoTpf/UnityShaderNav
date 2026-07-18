import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_VERSION, DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import {
  buildFingerprint,
  fingerprintsEqual,
  macroTableHash,
  settingsHash,
} from '../../src/cache/fingerprint';
import { CacheStore } from '../../src/cache/cacheStore';
import {
  resolveParserRuntimeAssets,
  type ParserRuntimeAssets,
} from '../../src/parser/runtimeAssets';

describe('settingsHash', () => {
  it('is stable across permutations of included fields', () => {
    const a = { ...DEFAULT_SETTINGS, includeDirectories: ['x', 'y'] };
    const b = { ...DEFAULT_SETTINGS, includeDirectories: ['y', 'x'] };

    expect(settingsHash(a)).toBe(settingsHash(b));
  });

  it('changes when a user macro is added', () => {
    const a = { ...DEFAULT_SETTINGS };
    const b = {
      ...DEFAULT_SETTINGS,
      declarationMacros: [{ pattern: 'M($name)', kind: 'variable' as const }],
    };

    expect(settingsHash(a)).not.toBe(settingsHash(b));
  });
});

describe('macroTableHash', () => {
  it('different user macros produce different hashes', () => {
    const a = macroTableHash([]);
    const b = macroTableHash([{ pattern: 'X($name)', kind: 'variable' }]);

    expect(a).not.toBe(b);
  });

  it('returns a stable content hash for built-in macro facts', () => {
    expect(macroTableHash([])).toMatch(/^[a-f0-9]{40}$/);
    expect(macroTableHash([])).toBe(macroTableHash([]));
  });
});

describe('buildFingerprint + fingerprintsEqual', () => {
  it('builds the same fingerprint from the same release version and grammar bytes', async () => {
    const first = await writeRuntimeAssets('grammar bytes\n');
    const second = await writeRuntimeAssets('grammar bytes\n');
    try {
      const releaseVersion = '0.1.1';
      const f1 = buildFingerprint(DEFAULT_SETTINGS, first.assets, releaseVersion);
      const f2 = buildFingerprint(DEFAULT_SETTINGS, second.assets, releaseVersion);

      expect(f1).toBeDefined();
      expect(f2).toBeDefined();
      if (!f1 || !f2) throw new Error('expected cache fingerprints');
      expect(fingerprintsEqual(f1, f2)).toBe(true);
      expect(f1.releaseVersion).toBe(releaseVersion);
      expect(f1.grammarVersion).toBe(first.assets.hlslGrammar.contentHash);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it('changes when only the release version changes', async () => {
    const runtime = await writeRuntimeAssets('grammar bytes\n');
    try {
      const first = buildFingerprint(DEFAULT_SETTINGS, runtime.assets, '0.1.1');
      const second = buildFingerprint(DEFAULT_SETTINGS, runtime.assets, '0.2.0');

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) throw new Error('expected cache fingerprints');
      expect(fingerprintsEqual(first, second)).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it('changes when only the loaded grammar bytes change', async () => {
    const firstRuntime = await writeRuntimeAssets('grammar A\n');
    const secondRuntime = await writeRuntimeAssets('grammar B\n');
    try {
      const first = buildFingerprint(DEFAULT_SETTINGS, firstRuntime.assets, '0.1.1');
      const second = buildFingerprint(DEFAULT_SETTINGS, secondRuntime.assets, '0.1.1');

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) throw new Error('expected cache fingerprints');
      expect(fingerprintsEqual(first, second)).toBe(false);
    } finally {
      await firstRuntime.cleanup();
      await secondRuntime.cleanup();
    }
  });

  it('rejects cached records produced by different grammar bytes', async () => {
    const firstRuntime = await writeRuntimeAssets('grammar A\n');
    const secondRuntime = await writeRuntimeAssets('grammar B\n');
    const cacheDir = await mkdtemp(join(tmpdir(), 'usn-grammar-cache-'));
    try {
      const first = buildFingerprint(DEFAULT_SETTINGS, firstRuntime.assets, '0.1.1');
      const second = buildFingerprint(DEFAULT_SETTINGS, secondRuntime.assets, '0.1.1');
      if (!first || !second) throw new Error('expected cache fingerprints');
      const store = new CacheStore(cacheDir);
      await store.save({
        version: CACHE_VERSION,
        workspaceFolderUri: 'file:///workspace',
        unityProjectRoot: '/workspace',
        createdAt: 1,
        fingerprint: first,
        files: [],
      });

      expect(await store.load(first)).not.toBeNull();
      expect(await store.load(second)).toBeNull();
    } finally {
      await firstRuntime.cleanup();
      await secondRuntime.cleanup();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('changes when index-affecting settings change', async () => {
    const runtime = await writeRuntimeAssets('grammar bytes\n');
    try {
      const changedSettings = {
        ...DEFAULT_SETTINGS,
        excludePatterns: [...DEFAULT_SETTINGS.excludePatterns, '**/Generated/**'],
      };
      const first = buildFingerprint(DEFAULT_SETTINGS, runtime.assets, '0.1.1');
      const second = buildFingerprint(changedSettings, runtime.assets, '0.1.1');
      if (!first || !second) throw new Error('expected cache fingerprints');

      expect(fingerprintsEqual(first, second)).toBe(false);
    } finally {
      await runtime.cleanup();
    }
  });

  it('does not create a persistable fingerprint without runtime assets or a release', async () => {
    const runtime = await writeRuntimeAssets('grammar bytes\n');
    try {
      expect(buildFingerprint(DEFAULT_SETTINGS, undefined, '0.1.1')).toBeUndefined();
      expect(buildFingerprint(DEFAULT_SETTINGS, runtime.assets, undefined)).toBeUndefined();
    } finally {
      await runtime.cleanup();
    }
  });
});

async function writeRuntimeAssets(grammar: string): Promise<{
  readonly assets: ParserRuntimeAssets;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'usn-fingerprint-runtime-'));
  const modulePath = join(root, 'server', 'src', 'parser', 'runtimeAssets.ts');
  const grammarPath = join(root, 'server', 'grammars', 'tree-sitter-hlsl.wasm');
  await mkdir(join(modulePath, '..'), { recursive: true });
  await mkdir(join(grammarPath, '..'), { recursive: true });
  await writeFile(modulePath, 'module bytes\n');
  await writeFile(grammarPath, grammar);
  return {
    assets: resolveParserRuntimeAssets(modulePath),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
