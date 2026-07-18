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
  it('projects vocabulary entries into suggestion metadata', () => {
    const text = 'float4 main() { return nor';
    const result = collect(text, 0, text.length);
    const normalize = result.find((suggestion) => suggestion.name === 'normalize');

    expect(normalize).toMatchObject({
      source: 'builtin',
      kind: 'function',
      sortText: '9_normalize',
      returnType: 'T',
      parameters: [{ type: 'T', name: 'x' }],
    });
  });

  it('returns HLSL, UnityCG, and URP entries in generic HLSL code', () => {
    const result = names('float4 main() { return ', 0, 23);

    expect(result).toEqual(expect.arrayContaining([
      'normalize',
      'UnityObjectToClipPos',
      'SAMPLE_TEXTURE2D',
      'float4',
    ]));
  });

  it('projects expanded free vocabulary without leaking receiver-owned methods', () => {
    const text = 'float4 main() { return ';
    const result = collect(text, 0, text.length);
    const byName = new Map(result.map((suggestion) => [suggestion.name, suggestion]));

    expect(byName.get('sincos')).toMatchObject({ kind: 'function' });
    expect(byName.get('_ProjectionParams')).toMatchObject({ kind: 'variable' });
    expect(byName.get('precise')).toMatchObject({ kind: 'keyword' });
    expect(byName.get('UNITY_PI')).toMatchObject({ kind: 'macro' });
    expect(byName.get('SAMPLE_TEXTURE2D_X')).toMatchObject({ kind: 'macro' });
    expect(byName.get('InputData')).toMatchObject({ kind: 'type' });

    expect([...byName.keys()]).not.toEqual(expect.arrayContaining([
      'Sample',
      'SampleLevel',
      'SampleBias',
      'SampleGrad',
      'SampleCmp',
      'Load',
      'Gather',
      'GetDimensions',
    ]));
  });

  it('projects overloaded intrinsics once for Completion', () => {
    const text = 'float4 main() { return asf';
    const result = collect(text, 0, text.length);

    expect(result.filter((suggestion) => suggestion.name === 'asfloat'))
      .toHaveLength(1);
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

  it('projects authoritative ShaderLab directives and Property types in outer code', () => {
    const shader = 'Shader "T/Test" { SubShader {  } }';
    const result = names(
      shader,
      0,
      shader.indexOf(' }'),
      'shaderlab',
      'file:///t/test.shader',
    );

    expect(result).toEqual(expect.arrayContaining([
      'UsePass',
      '2DArray',
      'CubeArray',
    ]));
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
    expect(result).not.toContain('UsePass');
    expect(result).not.toContain('2DArray');
    expect(result).not.toContain('CubeArray');
  });

  it('surfaces URP and HDRP entries together in generic HLSL code', () => {
    const result = names('float4 main() { return ', 0, 23);

    expect(result).toEqual(expect.arrayContaining([
      'SAMPLE_TEXTURE2D_LOD',
      'TransformObjectToHClip',
      'GetMainLight',
      'GetShadowFade',
      'MainLightRealtimeShadow',
    ]));
  });

  it('returns blend factor values after the Blend state name', () => {
    const shader = 'Shader "T/Test" { SubShader { Pass { Blend  } } }';
    const result = names(shader, 0, 44, 'shaderlab', 'file:///t/test.shader');

    expect(result).toEqual(expect.arrayContaining([
      'Zero',
      'One',
      'SrcAlpha',
      'OneMinusSrcAlpha',
    ]));
    expect(result).not.toContain('normalize');
  });

  it('returns blend operation values after the BlendOp state name', () => {
    const shader = 'Shader "T/Test" { SubShader { Pass { BlendOp  } } }';
    const result = names(shader, 0, 46, 'shaderlab', 'file:///t/test.shader');

    expect(result).toEqual(expect.arrayContaining([
      'Add',
      'Sub',
      'RevSub',
      'Min',
      'Max',
    ]));
  });
});
