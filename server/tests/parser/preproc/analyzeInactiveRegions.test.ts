import { describe, it, expect } from 'vitest';
import {
  analyzeInactiveRegions,
  type DimmedRegion,
} from '../../../src/parser/preproc/analyzeInactiveRegions';

/** Analyze an HLSL file (whole-text region). */
const hlsl = (text: string): DimmedRegion[] =>
  analyzeInactiveRegions(text, { isShaderLab: false });

/** Analyze a ShaderLab .shader file. */
const shader = (text: string): DimmedRegion[] =>
  analyzeInactiveRegions(text, { isShaderLab: true });

/** Convenience: does a region cover (inclusive) the given line range? */
const hasRegion = (regions: DimmedRegion[], startLine: number, endLine: number, reason?: 'inactive' | 'variant'): boolean =>
  regions.some(
    (r) =>
      r.range.start.line === startLine &&
      r.range.end.line === endLine &&
      r.range.start.character === 0 &&
      r.range.end.character === 0 &&
      (reason === undefined || r.reason === reason),
  );

describe('analyzeInactiveRegions — basic defines & variants', () => {
  it('definitely-defined branch stays visible', () => {
    const src = ['#define BAR_ON', '#ifdef BAR_ON', 'int a;', '#endif'].join('\n');
    expect(hlsl(src)).toEqual([]);
  });

  it('variant-dependent branch dims as variant', () => {
    const src = ['#pragma multi_compile _ FOO_ON', '#ifdef FOO_ON', 'int a;', '#endif'].join('\n');
    const regions = hlsl(src);
    // body is line 2 (0-based)
    expect(hasRegion(regions, 2, 2, 'variant')).toBe(true);
    expect(regions).toHaveLength(1);
  });

  it('never-seen macro stays visible (UNKNOWN)', () => {
    const src = ['#ifdef NEVER_SEEN', 'int a;', '#endif'].join('\n');
    expect(hlsl(src)).toEqual([]);
  });

  it('#ifndef of a defined macro dims as inactive', () => {
    const src = ['#define X', '#ifndef X', 'int a;', '#endif'].join('\n');
    const regions = hlsl(src);
    expect(hasRegion(regions, 2, 2, 'inactive')).toBe(true);
    expect(regions).toHaveLength(1);
  });
});

describe('analyzeInactiveRegions — #undef semantics', () => {
  it('#undef makes a later #ifdef dim and #ifndef visible; re-#define restores', () => {
    const src = [
      '#define X', // 0
      '#undef X', // 1
      '#ifdef X', // 2  -> FALSE -> dim inactive (body line 3)
      'a;', // 3
      '#endif', // 4
      '#ifndef X', // 5  -> TRUE -> visible
      'b;', // 6
      '#endif', // 7
      '#define X', // 8  re-define
      '#ifdef X', // 9 -> TRUE -> visible
      'c;', // 10
      '#endif', // 11
    ].join('\n');
    const regions = hlsl(src);
    expect(hasRegion(regions, 3, 3, 'inactive')).toBe(true);
    // #ifndef X body (line 6) must NOT be dimmed
    expect(regions.some((r) => r.range.start.line <= 6 && r.range.end.line >= 6)).toBe(false);
    // re-defined #ifdef X body (line 10) must NOT be dimmed
    expect(regions.some((r) => r.range.start.line <= 10 && r.range.end.line >= 10)).toBe(false);
    expect(regions).toHaveLength(1);
  });
});

describe('analyzeInactiveRegions — #if defined / !defined / && / ||', () => {
  it('#if defined(X) and #if !defined(X) mirror #ifdef/#ifndef', () => {
    const definedTrue = ['#define X', '#if defined(X)', 'a;', '#endif'].join('\n');
    expect(hlsl(definedTrue)).toEqual([]);

    const notDefinedDims = ['#define X', '#if !defined(X)', 'a;', '#endif'].join('\n');
    expect(hasRegion(hlsl(notDefinedDims), 2, 2, 'inactive')).toBe(true);
  });

  it('defined(A) && defined(B): VARIANT && TRUE dims as variant', () => {
    const src = [
      '#define B', // 0
      '#pragma multi_compile _ A', // 1
      '#if defined(A) && defined(B)', // 2  VARIANT && TRUE -> VARIANT
      'x;', // 3
      '#endif', // 4
    ].join('\n');
    expect(hasRegion(hlsl(src), 3, 3, 'variant')).toBe(true);
  });

  it('defined(A) || defined(B): FALSE || VARIANT dims as variant', () => {
    const src = [
      '#define B', // 0
      '#undef B', // 1  B is FALSE
      '#pragma multi_compile _ A', // 2
      '#if defined(A) || defined(B)', // 3  VARIANT || FALSE -> VARIANT
      'x;', // 4
      '#endif', // 5
    ].join('\n');
    expect(hasRegion(hlsl(src), 4, 4, 'variant')).toBe(true);
  });
});

describe('analyzeInactiveRegions — VARIANT || UNKNOWN false-dim guard', () => {
  it('VARIANT || UNKNOWN stays visible', () => {
    const src = [
      '#pragma multi_compile _ FOO_ON', // 0
      '#if defined(FOO_ON) || defined(NEVER_SEEN)', // 1  VARIANT || UNKNOWN -> UNKNOWN
      'x;', // 2
      '#endif', // 3
    ].join('\n');
    expect(hlsl(src)).toEqual([]);
  });

  it('VARIANT || FALSE (after #undef) dims as variant', () => {
    const src = [
      '#pragma multi_compile _ FOO_ON', // 0
      '#define X', // 1
      '#undef X', // 2  X is FALSE
      '#if defined(FOO_ON) || defined(X)', // 3  VARIANT || FALSE -> VARIANT
      'x;', // 4
      '#endif', // 5
    ].join('\n');
    expect(hasRegion(hlsl(src), 4, 4, 'variant')).toBe(true);
  });
});

describe('analyzeInactiveRegions — #else derivation', () => {
  it('#else of a definitely-active #if dims as inactive', () => {
    const src = [
      '#define X', // 0
      '#ifdef X', // 1 TRUE -> visible
      'a;', // 2
      '#else', // 3
      'b;', // 4  DEFINITELY_TAKEN -> dim inactive
      '#endif', // 5
    ].join('\n');
    const regions = hlsl(src);
    expect(hasRegion(regions, 4, 4, 'inactive')).toBe(true);
    expect(regions).toHaveLength(1);
  });

  it('#else of a variant #if dims as variant', () => {
    const src = [
      '#pragma multi_compile _ FOO_ON', // 0
      '#ifdef FOO_ON', // 1 VARIANT -> dim variant (body line 2)
      'a;', // 2
      '#else', // 3
      'b;', // 4 VARIANT_PENDING -> dim variant
      '#endif', // 5
    ].join('\n');
    const regions = hlsl(src);
    expect(hasRegion(regions, 2, 2, 'variant')).toBe(true);
    expect(hasRegion(regions, 4, 4, 'variant')).toBe(true);
  });

  it('#else of an all-FALSE chain stays visible', () => {
    const src = [
      '#define X', // 0
      '#undef X', // 1  X FALSE
      '#ifdef X', // 2  FALSE -> dim inactive (body line 3), state stays NONE_TAKEN
      'a;', // 3
      '#else', // 4  NONE_TAKEN -> visible
      'b;', // 5
      '#endif', // 6
    ].join('\n');
    const regions = hlsl(src);
    expect(hasRegion(regions, 3, 3, 'inactive')).toBe(true);
    // #else body (line 5) is visible
    expect(regions.some((r) => r.range.start.line <= 5 && r.range.end.line >= 5)).toBe(false);
    expect(regions).toHaveLength(1);
  });

  it('#else of an UNKNOWN chain stays visible (not definite)', () => {
    const src = [
      '#ifdef NEVER', // 0 UNKNOWN -> visible, UNKNOWN_PENDING
      'a;', // 1
      '#else', // 2 UNKNOWN_PENDING -> visible
      'b;', // 3
      '#endif', // 4
    ].join('\n');
    expect(hlsl(src)).toEqual([]);
  });
});

describe('analyzeInactiveRegions — nesting', () => {
  it('nested branch inside a dimmed parent emits one region over the whole parent body', () => {
    const src = [
      '#pragma multi_compile _ FOO_ON', // 0
      '#ifndef FOO_ON', // 1  FOO_ON is VARIANT -> ifndef -> VARIANT -> dim variant
      '  int a;', // 2
      '  #ifdef BAR', // 3  nested, must NOT be separately classified
      '    int b;', // 4
      '  #endif', // 5
      '  int c;', // 6
      '#endif', // 7
    ].join('\n');
    const regions = hlsl(src);
    // one region over the whole parent body lines 2..6
    expect(hasRegion(regions, 2, 6, 'variant')).toBe(true);
    expect(regions).toHaveLength(1);
  });

  it('nested variant branch inside a visible branch dims only its own body', () => {
    const src = [
      '#pragma multi_compile _ FOO_ON', // 0
      '#define GUARD', // 1
      '#ifdef GUARD', // 2 TRUE -> visible
      '  int a;', // 3
      '  #ifdef FOO_ON', // 4 VARIANT -> dim variant (body line 5)
      '    int b;', // 5
      '  #endif', // 6
      '  int c;', // 7
      '#endif', // 8
    ].join('\n');
    const regions = hlsl(src);
    expect(hasRegion(regions, 5, 5, 'variant')).toBe(true);
    expect(regions).toHaveLength(1);
  });

  it('dimmed parent with nested #if/#else/#endif emits ONE range (boundary regression)', () => {
    const src = [
      '#pragma multi_compile _ FOO_ON', // 0
      '#ifdef FOO_ON', // 1  VARIANT -> dim variant; body 2..8
      '  int a;', // 2
      '  #ifdef INNER', // 3  nested #if
      '    int b;', // 4
      '  #else', // 5  nested #else (must NOT be mistaken for parent boundary)
      '    int c;', // 6
      '  #endif', // 7  nested #endif (must NOT close the parent)
      '  int d;', // 8
      '#else', // 9  parent #else at matching depth -> VARIANT_PENDING -> dim variant; body 10
      '  int e;', // 10
      '#endif', // 11  parent #endif
    ].join('\n');
    const regions = hlsl(src);
    // parent's first clause: one region over 2..8
    expect(hasRegion(regions, 2, 8, 'variant')).toBe(true);
    // parent's #else clause: one region over line 10
    expect(hasRegion(regions, 10, 10, 'variant')).toBe(true);
    expect(regions).toHaveLength(2);
  });
});

describe('analyzeInactiveRegions — unknown / complex expressions', () => {
  it('unknown macro and arithmetic conditions stay visible', () => {
    const src = [
      '#if SOMETHING_FROM_INCLUDE', // 0 UNKNOWN
      'a;', // 1
      '#endif', // 2
      '#if 1', // 3 UNKNOWN (arithmetic literal not modeled)
      'b;', // 4
      '#endif', // 5
      '#if FOO > 2', // 6 UNKNOWN
      'c;', // 7
      '#endif', // 8
    ].join('\n');
    expect(hlsl(src)).toEqual([]);
  });
});

describe('analyzeInactiveRegions — ShaderLab blocks', () => {
  it('analyzes inside HLSLPROGRAM blocks in file coordinates; ignores directives outside blocks', () => {
    const src = [
      '#ifdef OUTSIDE_SHOULD_BE_IGNORED', // 0 outside any block
      'garbage', // 1
      '#endif', // 2
      'Shader "X" {', // 3
      '  SubShader {', // 4
      '    Pass {', // 5
      '      HLSLPROGRAM', // 6
      '      #pragma multi_compile _ FOO_ON', // 7
      '      #ifdef FOO_ON', // 8  VARIANT -> dim variant; body line 9
      '      int a;', // 9
      '      #endif', // 10
      '      ENDHLSL', // 11
      '    }', // 12
      '  }', // 13
      '}', // 14
    ].join('\n');
    const regions = shader(src);
    expect(hasRegion(regions, 9, 9, 'variant')).toBe(true);
    expect(regions).toHaveLength(1);
  });

  it('HLSLINCLUDE variant pragma → later HLSLPROGRAM #ifdef dims as variant (file-wide variants)', () => {
    const src = [
      'Shader "X" {', // 0
      '  HLSLINCLUDE', // 1
      '  #pragma multi_compile _ FOO_ON', // 2
      '  ENDHLSL', // 3
      '  SubShader {', // 4
      '    Pass {', // 5
      '      HLSLPROGRAM', // 6
      '      #ifdef FOO_ON', // 7  VARIANT (file-wide) -> dim variant; body line 8
      '      int a;', // 8
      '      #endif', // 9
      '      ENDHLSL', // 10
      '    }', // 11
      '  }', // 12
      '}', // 13
    ].join('\n');
    const regions = shader(src);
    expect(hasRegion(regions, 8, 8, 'variant')).toBe(true);
    expect(regions).toHaveLength(1);
  });

  it('HLSLINCLUDE #define seeds program blocks; no cross-pass leak between sibling HLSLPROGRAMs', () => {
    const src = [
      'Shader "X" {', // 0
      '  HLSLINCLUDE', // 1
      '  #define BAR_ON', // 2  folds into shared base
      '  ENDHLSL', // 3
      '  SubShader {', // 4
      '    Pass {', // 5
      '      HLSLPROGRAM', // 6
      '      #ifndef BAR_ON', // 7  TRUE-defined -> ifndef -> dim inactive; body 8
      '      int a;', // 8
      '      #endif', // 9
      '      #ifdef BAR_ON', // 10  defined -> visible
      '      int b;', // 11
      '      #endif', // 12
      '      #define LOCAL_ONLY', // 13  local to this program block
      '      ENDHLSL', // 14
      '    }', // 15
      '    Pass {', // 16
      '      HLSLPROGRAM', // 17
      '      #ifndef LOCAL_ONLY', // 18  LOCAL_ONLY did NOT leak -> UNKNOWN -> visible
      '      int c;', // 19
      '      #endif', // 20
      '      ENDHLSL', // 21
      '    }', // 22
      '  }', // 23
      '}', // 24
    ].join('\n');
    const regions = shader(src);
    // #ifndef BAR_ON in first program block dims (BAR_ON seeded as defined)
    expect(hasRegion(regions, 8, 8, 'inactive')).toBe(true);
    // #ifdef BAR_ON visible (line 11 not dimmed)
    expect(regions.some((r) => r.range.start.line <= 11 && r.range.end.line >= 11)).toBe(false);
    // sibling program block: LOCAL_ONLY did not leak, so #ifndef LOCAL_ONLY visible (line 19 not dimmed)
    expect(regions.some((r) => r.range.start.line <= 19 && r.range.end.line >= 19)).toBe(false);
    expect(regions).toHaveLength(1);
  });
});

describe('analyzeInactiveRegions — empty bodies & comments', () => {
  it('skips empty dimmed body (no body lines)', () => {
    const src = [
      '#define X', // 0
      '#undef X', // 1
      '#ifdef X', // 2 FALSE -> dim, but no body lines
      '#endif', // 3
    ].join('\n');
    expect(hlsl(src)).toEqual([]);
  });

  it('is comment-aware: a commented-out directive does not break the walk', () => {
    const src = [
      '#pragma multi_compile _ FOO_ON', // 0
      '#ifdef FOO_ON', // 1 VARIANT -> dim variant; body 2..3
      'int a; // #endif this is a comment', // 2
      'int b;', // 3
      '#endif', // 4
    ].join('\n');
    const regions = hlsl(src);
    expect(hasRegion(regions, 2, 3, 'variant')).toBe(true);
    expect(regions).toHaveLength(1);
  });
});
