import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import {
  BUILTIN_DECLARATION_MACROS,
  BUILTIN_REFERENCE_MACROS,
  BUILTIN_SENTINEL_MACROS,
} from '../../src/macros/builtin';
import {
  buildFingerprint,
  fingerprintsEqual,
  macroTableHash,
  settingsHash,
} from '../../src/cache/fingerprint';

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

  it('includes builtin sentinel macros to invalidate stale reference caches', () => {
    const expectedInputs = [
      ...BUILTIN_DECLARATION_MACROS.map((macro) => ({
        pattern: macro.pattern,
        kind: macro.kind,
        source: 'builtin-declaration',
      })),
      ...BUILTIN_REFERENCE_MACROS.map((macro) => ({
        pattern: macro.pattern,
        kind: macro.kind,
        source: 'builtin-reference',
      })),
      ...BUILTIN_SENTINEL_MACROS.map((macro) => ({
        pattern: macro,
        kind: 'sentinel',
        source: 'builtin-sentinel',
      })),
    ].sort((a, b) => (
      a.pattern.localeCompare(b.pattern)
      || String(a.kind).localeCompare(String(b.kind))
      || a.source.localeCompare(b.source)
    ));
    const expectedHash = createHash('sha1')
      .update(JSON.stringify(expectedInputs))
      .digest('hex');

    expect(macroTableHash([])).toBe(expectedHash);
  });
});

describe('buildFingerprint + fingerprintsEqual', () => {
  it('equal inputs produce equal fingerprints', async () => {
    const f1 = await buildFingerprint(DEFAULT_SETTINGS, '/nope');
    const f2 = await buildFingerprint(DEFAULT_SETTINGS, '/nope');

    expect(fingerprintsEqual(f1, f2)).toBe(true);
  });
});
