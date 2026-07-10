import { describe, it, expect } from 'vitest';
import { scanVariantKeywords } from '../../../src/parser/preproc/scanVariantKeywords';

const sorted = (set: Set<string>) => [...set].sort();

describe('scanVariantKeywords', () => {
  it('drops the bare underscore placeholder', () => {
    const out = scanVariantKeywords('#pragma multi_compile _ FOO_ON');
    expect(sorted(out)).toEqual(['FOO_ON']);
  });

  it('collects keywords from multi_compile_local and shader_feature', () => {
    const text = ['#pragma multi_compile_local A B', '#pragma shader_feature C'].join('\n');
    expect(sorted(scanVariantKeywords(text))).toEqual(['A', 'B', 'C']);
  });

  it('keeps keywords that merely start with an underscore', () => {
    const out = scanVariantKeywords('#pragma shader_feature_local _ _VARIANT_ON');
    expect(sorted(out)).toEqual(['_VARIANT_ON']);
  });

  it('recognizes suffixed multi_compile/shader_feature families', () => {
    const text = [
      '#pragma multi_compile_fragment X',
      '#pragma shader_feature_fragment Y',
    ].join('\n');
    expect(sorted(scanVariantKeywords(text))).toEqual(['X', 'Y']);
  });

  it('ignores commented-out pragmas', () => {
    const out = scanVariantKeywords('// #pragma multi_compile _ FOO');
    expect(sorted(out)).toEqual([]);
  });

  it('ignores pragmas inside block comments', () => {
    const text = ['/*', '#pragma multi_compile _ FOO', '*/'].join('\n');
    expect(sorted(scanVariantKeywords(text))).toEqual([]);
  });

  it('ignores non-variant pragmas', () => {
    const out = scanVariantKeywords('#pragma vertex vert');
    expect(sorted(out)).toEqual([]);
  });
});
