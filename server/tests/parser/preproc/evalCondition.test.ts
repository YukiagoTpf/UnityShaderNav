import { describe, it, expect } from 'vitest';
import type { VariantContext } from '@unity-shader-nav/shared';
import {
  evalCondition,
  evalDefined,
  type CondKind,
  type CondValue,
  type MacroState,
} from '../../../src/parser/preproc/evalCondition';

/**
 * Build a MacroState placing each named macro into one of the four buckets:
 *   D → defined (TRUE), U → undefed (FALSE), V → variants (VARIANT), absent → UNKNOWN.
 *
 * `active` is a shorthand for a non-empty VariantContext: when present it sets
 * `variantContext.activeKeywords`, which resolves variant keywords to TRUE/FALSE.
 * An absent or empty `active` deliberately leaves `variantContext` unset — the
 * conservative fallback where variant keywords keep returning VARIANT.
 */
const state = (
  buckets: { D?: string[]; U?: string[]; V?: string[]; active?: string[] } = {},
): MacroState => ({
  defined: new Set(buckets.D ?? []),
  undefed: new Set(buckets.U ?? []),
  variants: new Set(buckets.V ?? []),
  ...(buckets.active?.length
    ? { variantContext: { activeKeywords: new Set(buckets.active) } }
    : {}),
});

/**
 * Build a MacroState with an explicitly supplied VariantContext — covers the
 * empty-`activeKeywords` fallback that the `active` shorthand cannot express.
 */
const stateWithContext = (
  variantContext: VariantContext,
  buckets: { D?: string[]; U?: string[]; V?: string[] } = {},
): MacroState => ({ ...state(buckets), variantContext });

describe('evalDefined', () => {
  it('applies precedence defined → undefed → variants → unknown', () => {
    const s = state({ D: ['A'], U: ['B'], V: ['C'] });
    expect(evalDefined('A', s)).toBe('TRUE');
    expect(evalDefined('B', s)).toBe('FALSE');
    expect(evalDefined('C', s)).toBe('VARIANT');
    expect(evalDefined('D', s)).toBe('UNKNOWN');
  });

  it('lets defined win when a name is in both defined and undefed (defined first)', () => {
    expect(evalDefined('X', state({ D: ['X'], U: ['X'] }))).toBe('TRUE');
  });
});

describe('evalCondition — single name across the four buckets', () => {
  const buckets: Array<{ name: string; s: MacroState; atom: CondValue }> = [
    { name: 'defined', s: state({ D: ['X'] }), atom: 'TRUE' },
    { name: 'undefed', s: state({ U: ['X'] }), atom: 'FALSE' },
    { name: 'variant', s: state({ V: ['X'] }), atom: 'VARIANT' },
    { name: 'absent', s: state(), atom: 'UNKNOWN' },
  ];

  const negate = (v: CondValue): CondValue =>
    v === 'TRUE' ? 'FALSE' : v === 'FALSE' ? 'TRUE' : v;

  for (const { name, s, atom } of buckets) {
    it(`#ifdef X / #if defined(X) → ${atom} when X is ${name}`, () => {
      expect(evalCondition('ifdef', 'X', s)).toBe(atom);
      expect(evalCondition('if', 'defined(X)', s)).toBe(atom);
      expect(evalCondition('if', 'defined X', s)).toBe(atom);
      expect(evalCondition('elif', 'defined(X)', s)).toBe(atom);
    });

    it(`#ifndef X / #if !defined(X) → ${negate(atom)} when X is ${name}`, () => {
      expect(evalCondition('ifndef', 'X', s)).toBe(negate(atom));
      expect(evalCondition('if', '!defined(X)', s)).toBe(negate(atom));
      expect(evalCondition('if', '! defined X', s)).toBe(negate(atom));
    });
  }

  it('ifndef of an undefed name is TRUE; ifdef of an undefed name is FALSE', () => {
    const s = state({ U: ['X'] });
    expect(evalCondition('ifndef', 'X', s)).toBe('TRUE');
    expect(evalCondition('ifdef', 'X', s)).toBe('FALSE');
  });
});

describe('evalCondition — defined(A) && defined(B) (and table)', () => {
  const bucketOf = (v: CondValue) =>
    v === 'TRUE' ? 'D' : v === 'FALSE' ? 'U' : v === 'VARIANT' ? 'V' : undefined;

  const mkState = (a: CondValue, b: CondValue): MacroState => {
    const buckets: { D?: string[]; U?: string[]; V?: string[] } = {};
    const put = (name: string, v: CondValue) => {
      const k = bucketOf(v);
      if (k) (buckets[k] ??= []).push(name);
    };
    put('A', a);
    put('B', b);
    return state(buckets);
  };

  // FALSE if any FALSE; else UNKNOWN if any UNKNOWN; else VARIANT if any VARIANT; else TRUE.
  const cases: Array<[CondValue, CondValue, CondValue]> = [
    ['TRUE', 'TRUE', 'TRUE'],
    ['TRUE', 'FALSE', 'FALSE'],
    ['FALSE', 'UNKNOWN', 'FALSE'],
    ['FALSE', 'VARIANT', 'FALSE'],
    ['UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
    ['TRUE', 'UNKNOWN', 'UNKNOWN'],
    ['VARIANT', 'UNKNOWN', 'UNKNOWN'],
    ['VARIANT', 'TRUE', 'VARIANT'],
    ['VARIANT', 'VARIANT', 'VARIANT'],
  ];

  for (const [a, b, want] of cases) {
    it(`${a} && ${b} → ${want}`, () => {
      expect(evalCondition('if', 'defined(A) && defined(B)', mkState(a, b))).toBe(want);
    });
  }

  it('explicitly: VARIANT && UNKNOWN → UNKNOWN', () => {
    expect(evalCondition('if', 'defined(A) && defined(B)', mkState('VARIANT', 'UNKNOWN'))).toBe(
      'UNKNOWN',
    );
  });

  it('explicitly: VARIANT && TRUE → VARIANT', () => {
    expect(evalCondition('if', 'defined(A) && defined(B)', mkState('VARIANT', 'TRUE'))).toBe(
      'VARIANT',
    );
  });
});

describe('evalCondition — defined(A) || defined(B) (or table)', () => {
  const bucketOf = (v: CondValue) =>
    v === 'TRUE' ? 'D' : v === 'FALSE' ? 'U' : v === 'VARIANT' ? 'V' : undefined;

  const mkState = (a: CondValue, b: CondValue): MacroState => {
    const buckets: { D?: string[]; U?: string[]; V?: string[] } = {};
    const put = (name: string, v: CondValue) => {
      const k = bucketOf(v);
      if (k) (buckets[k] ??= []).push(name);
    };
    put('A', a);
    put('B', b);
    return state(buckets);
  };

  // TRUE if any TRUE; else UNKNOWN if any UNKNOWN; else VARIANT if any VARIANT; else FALSE.
  const cases: Array<[CondValue, CondValue, CondValue]> = [
    ['TRUE', 'FALSE', 'TRUE'],
    ['TRUE', 'UNKNOWN', 'TRUE'],
    ['FALSE', 'FALSE', 'FALSE'],
    ['FALSE', 'UNKNOWN', 'UNKNOWN'],
    ['UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
    ['VARIANT', 'UNKNOWN', 'UNKNOWN'],
    ['VARIANT', 'FALSE', 'VARIANT'],
    ['VARIANT', 'VARIANT', 'VARIANT'],
  ];

  for (const [a, b, want] of cases) {
    it(`${a} || ${b} → ${want}`, () => {
      expect(evalCondition('if', 'defined(A) || defined(B)', mkState(a, b))).toBe(want);
    });
  }

  it('explicitly: VARIANT || UNKNOWN → UNKNOWN', () => {
    expect(evalCondition('if', 'defined(A) || defined(B)', mkState('VARIANT', 'UNKNOWN'))).toBe(
      'UNKNOWN',
    );
  });

  it('explicitly: VARIANT || FALSE → VARIANT', () => {
    expect(evalCondition('if', 'defined(A) || defined(B)', mkState('VARIANT', 'FALSE'))).toBe(
      'VARIANT',
    );
  });
});

describe('evalCondition — literals, bare macros, comparisons, and precedence', () => {
  it('coerces integer literals with C truthiness', () => {
    expect(evalCondition('if', '0', state())).toBe('FALSE');
    expect(evalCondition('if', '1', state())).toBe('TRUE');
    expect(evalCondition('elif', '42', state())).toBe('TRUE');
  });

  it('resolves a bare macro through the same four macro-state buckets as ifdef', () => {
    const cases: Array<[MacroState, CondValue]> = [
      [state({ D: ['MACRO'] }), 'TRUE'],
      [state({ U: ['MACRO'] }), 'FALSE'],
      [state({ V: ['MACRO'] }), 'VARIANT'],
      [state(), 'UNKNOWN'],
    ];

    for (const [macroState, expected] of cases) {
      expect(evalCondition('if', 'MACRO', macroState)).toBe(expected);
      expect(evalCondition('ifdef', 'MACRO', macroState)).toBe(expected);
    }
  });

  it('evaluates integer comparisons and parenthesized subexpressions', () => {
    const comparisons: Array<[string, CondValue]> = [
      ['1 < 2', 'TRUE'],
      ['2 <= 2', 'TRUE'],
      ['3 > 4', 'FALSE'],
      ['4 >= 4', 'TRUE'],
      ['5 == 5', 'TRUE'],
      ['5 != 5', 'FALSE'],
      ['(1 < 2) && (3 >= 3)', 'TRUE'],
      ['(1 > 2) || (3 != 3)', 'FALSE'],
    ];

    for (const [expr, expected] of comparisons) {
      expect(evalCondition('if', expr, state())).toBe(expected);
    }
  });

  it('keeps comparisons involving macros without a proven integer value unknown', () => {
    expect(evalCondition('if', 'UNITY_VERSION >= 202120', state())).toBe('UNKNOWN');
    expect(evalCondition('if', 'LOCAL_VERSION >= 1', state({ D: ['LOCAL_VERSION'] })))
      .toBe('UNKNOWN');
  });

  it('uses standard && before || precedence and lets parentheses override it', () => {
    const s = state({ D: ['A', 'C'], U: ['B'] });
    expect(evalCondition('if', 'defined(A) && defined(B) || defined(C)', s)).toBe('TRUE');
    expect(evalCondition('if', 'defined(A) || defined(B) && defined(B)', s)).toBe('TRUE');
    expect(evalCondition('if', '(defined(A) || defined(B)) && defined(B)', s)).toBe('FALSE');
  });

  it('preserves UNKNOWN dominance over VARIANT in mixed expressions', () => {
    const s = state({ V: ['VARIANT_MACRO'] });
    expect(evalCondition('if', 'UNKNOWN_MACRO && 1 || VARIANT_MACRO', s)).toBe('UNKNOWN');
  });
});

describe('evalCondition — unsupported expressions collapse to UNKNOWN', () => {
  const s = state({ D: ['A'], V: ['FOO'] });
  const unsupported: Array<[CondKind, string]> = [
    ['if', 'A > 2'],
    ['if', 'FOO(1)'],
    ['if', 'A == B'],
    ['if', 'defined(A) +'],
    ['if', ''],
    ['ifdef', 'A B'], // not a bare name
    ['ifdef', '1NOPE'],
  ];

  for (const [kind, expr] of unsupported) {
    it(`#${kind} ${expr || '<empty>'} → UNKNOWN`, () => {
      expect(evalCondition(kind, expr, s)).toBe('UNKNOWN');
    });
  }
});

describe('evalDefined with VariantContext', () => {
  it('returns TRUE for a variant keyword that is active', () => {
    expect(evalDefined('FOO', state({ V: ['FOO'], active: ['FOO'] }))).toBe('TRUE');
  });

  it('returns FALSE for a declared variant keyword that is not active', () => {
    expect(evalDefined('FOO', state({ V: ['FOO'], active: ['BAR'] }))).toBe('FALSE');
  });

  it('keeps returning VARIANT when no variantContext is supplied (unchanged)', () => {
    expect(evalDefined('FOO', state({ V: ['FOO'] }))).toBe('VARIANT');
  });

  it('keeps returning VARIANT when variantContext has empty activeKeywords (conservative fallback)', () => {
    const s = stateWithContext({ activeKeywords: new Set<string>() }, { V: ['FOO'] });
    expect(evalDefined('FOO', s)).toBe('VARIANT');
  });

  it('lets defined win over the variant context', () => {
    expect(evalDefined('FOO', state({ D: ['FOO'], V: ['FOO'], active: [] }))).toBe('TRUE');
  });

  it('lets undefed win over the variant context', () => {
    expect(evalDefined('FOO', state({ U: ['FOO'], V: ['FOO'], active: ['FOO'] }))).toBe('FALSE');
  });

  it('keeps returning UNKNOWN for a non-variant keyword when a context is present (unchanged)', () => {
    expect(evalDefined('BAZ', state({ active: ['FOO'] }))).toBe('UNKNOWN');
  });
});

describe('evalCondition with VariantContext', () => {
  it('#ifdef FOO → TRUE (not VARIANT) when FOO is active', () => {
    expect(evalCondition('ifdef', 'FOO', state({ V: ['FOO'], active: ['FOO'] }))).toBe('TRUE');
  });

  it('#ifdef FOO → FALSE (not VARIANT) when FOO is inactive', () => {
    expect(evalCondition('ifdef', 'FOO', state({ V: ['FOO'], active: ['BAR'] }))).toBe('FALSE');
  });

  it('#ifndef FOO → FALSE when FOO is active', () => {
    expect(evalCondition('ifndef', 'FOO', state({ V: ['FOO'], active: ['FOO'] }))).toBe('FALSE');
  });

  it('#ifndef FOO → TRUE when FOO is inactive', () => {
    expect(evalCondition('ifndef', 'FOO', state({ V: ['FOO'], active: ['BAR'] }))).toBe('TRUE');
  });

  it('#if defined(FOO) && defined(BAR) → FALSE when FOO is active but BAR is inactive', () => {
    const s = state({ V: ['FOO', 'BAR'], active: ['FOO'] });
    expect(evalCondition('if', 'defined(FOO) && defined(BAR)', s)).toBe('FALSE');
  });

  it('#if defined(FOO) || defined(BAR) → TRUE when FOO is inactive but BAR is active', () => {
    const s = state({ V: ['FOO', 'BAR'], active: ['BAR'] });
    expect(evalCondition('if', 'defined(FOO) || defined(BAR)', s)).toBe('TRUE');
  });

  it('#if defined(FOO) → VARIANT (unchanged) when no variantContext is supplied', () => {
    expect(evalCondition('if', 'defined(FOO)', state({ V: ['FOO'] }))).toBe('VARIANT');
  });
});
