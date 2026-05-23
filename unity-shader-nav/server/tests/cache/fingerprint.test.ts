import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
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
});

describe('buildFingerprint + fingerprintsEqual', () => {
  it('equal inputs produce equal fingerprints', async () => {
    const f1 = await buildFingerprint(DEFAULT_SETTINGS, '/nope');
    const f2 = await buildFingerprint(DEFAULT_SETTINGS, '/nope');

    expect(fingerprintsEqual(f1, f2)).toBe(true);
  });
});
