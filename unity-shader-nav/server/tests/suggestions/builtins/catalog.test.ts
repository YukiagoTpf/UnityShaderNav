import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CATEGORIES,
  BUILTIN_ENTRIES,
  builtinEntryToSuggestion,
} from '../../../src/suggestions/builtins';

function entryNamed(name: string) {
  const entry = BUILTIN_ENTRIES.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Missing built-in entry ${name}`);
  return entry;
}

describe('built-in suggestion catalog', () => {
  it('maps built-in function entries to shader suggestions', () => {
    const suggestion = builtinEntryToSuggestion(entryNamed('lerp'));

    expect(suggestion).toMatchObject({
      name: 'lerp',
      kind: 'function',
      source: 'builtin',
      returnType: 'T',
      sortText: '9_lerp',
    });
    expect(suggestion.parameters).toEqual([
      { type: 'T', name: 'x' },
      { type: 'T', name: 'y' },
      { type: 'T', name: 's' },
    ]);
  });

  it('maps ShaderLab state entries to shader suggestions', () => {
    const suggestion = builtinEntryToSuggestion(entryNamed('Cull'));

    expect(suggestion).toMatchObject({
      name: 'Cull',
      kind: 'state',
      source: 'builtin',
      detail: 'ShaderLab render state',
      sortText: '9_Cull',
    });
  });

  it('keeps built-in function parameters in the shared ShaderParameter shape', () => {
    const normalize = builtinEntryToSuggestion(entryNamed('normalize'));

    expect(normalize.parameters).toEqual([{ type: 'T', name: 'x' }]);
    expect(normalize.parameters?.[0]).not.toHaveProperty('range');
  });

  it('contains the planned initial high-signal vocabulary', () => {
    for (const name of [
      'normalize',
      'dot',
      'lerp',
      'saturate',
      'mul',
      'tex2D',
      'float4',
      'half4',
      'UnityObjectToClipPos',
      'TRANSFORM_TEX',
      'SAMPLE_TEXTURE2D',
      'TEXTURE2D',
      'SAMPLER',
      'Blend',
      'Cull',
      'ZWrite',
      'ZTest',
      'Pass',
      'SubShader',
      'POSITION',
      'SV_POSITION',
      'SV_Target',
      'TEXCOORD0',
      'Off',
      'On',
      'Back',
      'Front',
      'Always',
      'LEqual',
    ]) {
      expect(BUILTIN_ENTRIES.map((entry) => entry.name)).toContain(name);
    }
  });

  it('uses only valid categories and excludes HDRP from the initial catalog', () => {
    const categories = new Set(BUILTIN_CATEGORIES);

    for (const entry of BUILTIN_ENTRIES) {
      expect(categories.has(entry.category)).toBe(true);
      expect(entry.category).not.toBe('hdrp');
    }
  });
});
