import { describe, expect, it } from 'vitest';
import {
  analyzeDeclaredVariantCosts,
  scanDeclaredVariantPragmas,
} from '../../../src/parser/preproc/declaredVariantCost';

describe('scanDeclaredVariantPragmas', () => {
  it('recognizes local and stage-suffixed keyword-set directives', () => {
    const pragmas = scanDeclaredVariantPragmas([
      '#pragma multi_compile_local_fragment _ QUALITY_LOW QUALITY_HIGH',
      '# pragma shader_feature_vertex FOG_ON',
    ].join('\n'));

    expect(pragmas).toMatchObject([
      {
        line: 0,
        family: 'multi_compile',
        local: true,
        stage: 'fragment',
        keywords: ['QUALITY_LOW', 'QUALITY_HIGH'],
        hasBlankOption: true,
        multiplier: 3,
      },
      {
        line: 1,
        family: 'shader_feature',
        local: false,
        stage: 'vertex',
        keywords: ['FOG_ON'],
        hasBlankOption: true,
        multiplier: 2,
      },
    ]);
  });

  it('normalizes underscore placeholders and repeated options as one set option', () => {
    const [pragma] = scanDeclaredVariantPragmas(
      '#pragma multi_compile _ __ FOO FOO _BAR',
    );

    expect(pragma).toMatchObject({
      keywords: ['FOO', '_BAR'],
      hasBlankOption: true,
      multiplier: 3,
      duplicateOptions: true,
    });
  });

  it('uses the implicit shader_feature off option only for a single named keyword', () => {
    const pragmas = scanDeclaredVariantPragmas([
      '#pragma shader_feature FEATURE_ON',
      '#pragma shader_feature RED GREEN',
      '#pragma shader_feature _ RED GREEN',
    ].join('\n'));

    expect(pragmas.map(({ hasBlankOption, multiplier }) => ({
      hasBlankOption,
      multiplier,
    }))).toEqual([
      { hasBlankOption: true, multiplier: 2 },
      { hasBlankOption: false, multiplier: 2 },
      { hasBlankOption: true, multiplier: 3 },
    ]);
  });

  it('marks declarations nested in any conditional without selecting a branch', () => {
    const pragmas = scanDeclaredVariantPragmas([
      '#if SHADER_API_DESKTOP',
      '#pragma multi_compile DESKTOP_LOW DESKTOP_HIGH',
      '#else',
      '#pragma shader_feature MOBILE_QUALITY',
      '#endif',
      '#pragma multi_compile OUTSIDE_A OUTSIDE_B',
    ].join('\n'));

    expect(pragmas.map(({ conditional }) => conditional)).toEqual([true, true, false]);
  });

  it('ignores shortcuts, unknown suffixes, malformed options, and comments', () => {
    const pragmas = scanDeclaredVariantPragmas([
      '#pragma multi_compile_fog FOG_LINEAR',
      '#pragma multi_compile_pixel PIXEL_ON',
      '#pragma multi_compile GOOD BAD=1',
      '// #pragma shader_feature COMMENTED',
      '/* #pragma shader_feature BLOCK_COMMENTED */',
    ].join('\n'));

    expect(pragmas).toEqual([]);
  });
});

describe('analyzeDeclaredVariantCosts', () => {
  it('counts a duplicate keyword set once while keeping every declaration visible', () => {
    const analysis = analyzeDeclaredVariantCosts([
      '#pragma multi_compile _ A B',
      '#pragma shader_feature _ B A',
      '#pragma shader_feature_local A B',
    ].join('\n'), false);
    const [program] = analysis.programs;

    expect(program.upperBound).toBe(6n);
    expect(program.uniqueSetCount).toBe(2);
    expect(program.largestMultiplier).toBe(3);
    expect(program.contributions.map((contribution) => ({
      duplicateSet: contribution.duplicateSet,
      effectiveMultiplier: contribution.effectiveMultiplier,
    }))).toEqual([
      { duplicateSet: false, effectiveMultiplier: 3 },
      { duplicateSet: true, effectiveMultiplier: 1 },
      { duplicateSet: false, effectiveMultiplier: 2 },
    ]);
  });

  it('multiplies distinct declarations across conditional branches as a static upper bound', () => {
    const analysis = analyzeDeclaredVariantCosts([
      '#if SHADER_API_DESKTOP',
      '#pragma multi_compile DESKTOP_LOW DESKTOP_HIGH',
      '#else',
      '#pragma shader_feature MOBILE_QUALITY',
      '#endif',
    ].join('\n'), false);

    expect(analysis.programs[0].upperBound).toBe(4n);
    expect(analysis.programs[0].contributions.every(({ pragma }) => pragma.conditional)).toBe(true);
  });

  it('propagates HLSLINCLUDE and CGINCLUDE sets only to matching program kinds', () => {
    const text = [
      'Shader "VariantCost" {',
      '  HLSLINCLUDE',
      '  #pragma shader_feature SHARED',
      '  ENDHLSL',
      '  CGINCLUDE',
      '  #pragma multi_compile CG_LOW CG_MEDIUM CG_HIGH',
      '  ENDCG',
      '  SubShader {',
      '    Pass {',
      '    HLSLPROGRAM',
      '      #pragma multi_compile QUALITY_LOW QUALITY_MEDIUM QUALITY_HIGH',
      '    ENDHLSL',
      '    }',
      '    Pass {',
      '    HLSLPROGRAM',
      '      #pragma multi_compile _ SHARED',
      '    ENDHLSL',
      '    }',
      '    Pass {',
      '    CGPROGRAM',
      '    ENDCG',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const analysis = analyzeDeclaredVariantCosts(text, true);

    expect(analysis.programs.map((program) => ({
      kind: program.kind,
      upperBound: program.upperBound,
      duplicates: program.contributions.map(({ duplicateSet }) => duplicateSet),
    }))).toEqual([
      { kind: 'HLSLPROGRAM', upperBound: 6n, duplicates: [false, false] },
      { kind: 'HLSLPROGRAM', upperBound: 2n, duplicates: [false, true] },
      { kind: 'CGPROGRAM', upperBound: 3n, duplicates: [false] },
    ]);
  });

  it('keeps products exact beyond Number.MAX_SAFE_INTEGER', () => {
    const text = Array.from(
      { length: 60 },
      (_, index) => `#pragma multi_compile OPTION_${index}_A OPTION_${index}_B`,
    ).join('\n');

    expect(analyzeDeclaredVariantCosts(text, false).programs[0].upperBound)
      .toBe(1_152_921_504_606_846_976n);
  });
});
