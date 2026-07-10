import { describe, it, expect } from 'vitest';
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
 */
const state = (buckets: { D?: string[]; U?: string[]; V?: string[] } = {}): MacroState => ({
  defined: new Set(buckets.D ?? []),
  undefed: new Set(buckets.U ?? []),
  variants: new Set(buckets.V ?? []),
});

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

describe('evalCondition — unsupported expressions collapse to UNKNOWN', () => {
  const s = state({ D: ['A'], V: ['FOO'] });
  const unsupported: Array<[CondKind, string]> = [
    ['if', 'A > 2'],
    ['if', 'FOO(1)'],
    ['if', '1'],
    ['if', '0'],
    ['if', 'A == B'],
    ['if', 'defined(A) && defined(B) || defined(C)'], // mixed && / ||
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
