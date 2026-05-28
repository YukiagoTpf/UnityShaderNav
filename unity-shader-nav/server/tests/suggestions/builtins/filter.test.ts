import { describe, expect, it } from 'vitest';
import {
  collectBuiltinSuggestions,
  suggestionContextAt,
} from '../../../src/suggestions';

function collect(text: string, line: number, character: number, languageId = 'hlsl', uri = 'file:///t/test.hlsl') {
  const context = suggestionContextAt(text, { line, character }, languageId, uri);
  return collectBuiltinSuggestions(context);
}

function names(text: string, line: number, character: number, languageId = 'hlsl', uri = 'file:///t/test.hlsl') {
  return collect(text, line, character, languageId, uri).map((suggestion) => suggestion.name);
}

describe('built-in suggestion filtering', () => {
  it('returns HLSL, UnityCG, and URP entries in generic HLSL code', () => {
    const result = names('float4 main() { return ', 0, 23);

    expect(result).toEqual(expect.arrayContaining([
      'normalize',
      'UnityObjectToClipPos',
      'SAMPLE_TEXTURE2D',
      'float4',
    ]));
  });

  it('returns only semantic entries in semantic positions', () => {
    const text = 'struct Varyings { float4 positionCS : ';
    const result = names(text, 0, text.length);

    expect(result).toEqual(expect.arrayContaining(['SV_Target', 'TEXCOORD0']));
    expect(result).not.toContain('normalize');
    expect(result).not.toContain('Blend');
  });

  it('returns ShaderLab state keywords in ShaderLab code', () => {
    const shader = 'Shader "T/Test" { SubShader { Pass { Z } } }';
    const result = names(shader, 0, 36, 'shaderlab', 'file:///t/test.shader');

    expect(result).toEqual(expect.arrayContaining(['ZWrite', 'ZTest']));
    expect(result).not.toContain('normalize');
    expect(result).not.toContain('Off');
  });

  it('returns ShaderLab state values after state names', () => {
    const shader = 'Shader "T/Test" { SubShader { Pass { Cull  } } }';
    const result = names(shader, 0, 43, 'shaderlab', 'file:///t/test.shader');

    expect(result).toEqual(expect.arrayContaining(['Off', 'On', 'Back', 'Front', 'LEqual']));
    expect(result).not.toContain('Cull');
    expect(result).not.toContain('normalize');
  });

  it('returns no built-ins inside comments or strings', () => {
    expect(names('// normal', 0, 9)).toEqual([]);
    expect(names('float4 main() { return "normal"; }', 0, 29)).toEqual([]);
  });

  it('applies case-sensitive prefix filtering', () => {
    expect(names('float4 main() { return tex', 0, 27)).toEqual(expect.arrayContaining(['tex2D']));
    expect(names('float4 main() { return TEX', 0, 27))
      .toEqual(expect.not.arrayContaining(['tex2D']));
    expect(names('float4 main() { return float', 0, 29)).toEqual(expect.arrayContaining(['float2', 'float3', 'float4']));
    const svText = 'struct V { float4 pos : SV_';
    const lowerSvText = 'struct V { float4 pos : sv_';
    expect(names(svText, 0, svText.length)).toEqual(expect.arrayContaining(['SV_POSITION', 'SV_Target']));
    expect(names(lowerSvText, 0, lowerSvText.length)).toEqual([]);

    const shader = 'Shader "T/Test" { SubShader { Pass { Z } } }';
    expect(names(shader, 0, 38, 'shaderlab', 'file:///t/test.shader')).toEqual(['ZWrite', 'ZTest']);
  });

  it('does not return semantic entries or ShaderLab values in generic HLSL code', () => {
    const result = names('float4 main() { return ', 0, 23);

    expect(result).not.toContain('SV_Target');
    expect(result).not.toContain('Off');
  });
});
