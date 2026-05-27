import { describe, expect, it } from 'vitest';
import { scanShaderLabTokens } from '../../../src/parser/shaderlab/tokenScanner';

function tokenTexts(text: string): Array<{ text: string; type: string }> {
  const lines = text.split(/\r?\n/);
  return scanShaderLabTokens(text).map((token) => ({
    text: lines[token.range.start.line].slice(
      token.range.start.character,
      token.range.end.character,
    ),
    type: token.tokenType,
  }));
}

describe('scanShaderLabTokens', () => {
  it('scans ShaderLab wrapper, Properties, Tags, preprocessor, macros, and semantics', () => {
    const text = [
      'Shader "Custom/Mixed" {',
      '  Properties {',
      '    [Header(Main)] [Space]',
      '    _BaseMap ("Base Map", 2D) = "white" {}',
      '    _Tint ("Tint", Color) = (1, 0.5, 0, 1)',
      '    _Roughness ("Roughness", Range(0, 1)) = 0.5',
      '  }',
      '  SubShader {',
      '    Tags { "LightMode"="UniversalForward" "RenderType"="Opaque" }',
      '    LOD 100',
      '    Pass {',
      '      Name "Forward"',
      '      Cull Back',
      '      ZWrite On',
      '      HLSLPROGRAM',
      '      #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '      #pragma vertex vert',
      '      #define SAMPLE_ALBEDO(tex, uv) tex.Sample(sampler##tex, uv)',
      '      TEXTURE2D(_BaseMap);',
      '      SAMPLER(sampler_BaseMap);',
      '      CBUFFER_START(UnityPerMaterial)',
      '      struct Attributes { float3 positionOS : POSITION; };',
      '      float4 frag(Attributes input) : SV_Target { return float4(input.positionOS.xy, 0, 1); }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(tokenTexts(text)).toEqual(expect.arrayContaining([
      { text: 'Shader', type: 'keyword' },
      { text: 'Properties', type: 'keyword' },
      { text: 'Header', type: 'decorator' },
      { text: '_BaseMap', type: 'property' },
      { text: 'Base Map', type: 'string' },
      { text: '2D', type: 'type' },
      { text: 'Color', type: 'type' },
      { text: 'Range', type: 'type' },
      { text: 'LightMode', type: 'property' },
      { text: 'UniversalForward', type: 'string' },
      { text: 'LOD', type: 'keyword' },
      { text: 'Cull', type: 'keyword' },
      { text: 'ZWrite', type: 'keyword' },
      { text: 'HLSLPROGRAM', type: 'keyword' },
      { text: '#include', type: 'keyword' },
      { text: 'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl', type: 'string' },
      { text: '#pragma', type: 'keyword' },
      { text: '#define', type: 'keyword' },
      { text: 'SAMPLE_ALBEDO', type: 'macro' },
      { text: 'TEXTURE2D', type: 'macro' },
      { text: 'SAMPLER', type: 'macro' },
      { text: 'CBUFFER_START', type: 'macro' },
      { text: 'POSITION', type: 'enumMember' },
      { text: 'SV_Target', type: 'enumMember' },
      { text: 'xy', type: 'property' },
      { text: 'ENDHLSL', type: 'keyword' },
    ]));
  });

  it('ignores ShaderLab and preprocessor syntax inside comments', () => {
    const text = [
      'Shader "Custom/Comments" {',
      '  // Properties { _Ignored ("Ignored", Float) = 0 }',
      '  /* Tags { "RenderType"="Opaque" }',
      '     HLSLPROGRAM',
      '     #define IGNORED 1',
      '  */',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      // #include "Ignored.hlsl"',
      '      /* #pragma vertex ignored */',
      '      float4 frag() : SV_Target { return 0; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const tokens = tokenTexts(text);

    expect(tokens).toEqual(expect.arrayContaining([
      { text: 'Shader', type: 'keyword' },
      { text: 'SubShader', type: 'keyword' },
      { text: 'HLSLPROGRAM', type: 'keyword' },
      { text: 'SV_Target', type: 'enumMember' },
      { text: 'ENDHLSL', type: 'keyword' },
    ]));
    expect(tokens).not.toEqual(expect.arrayContaining([
      { text: 'Properties', type: 'keyword' },
      { text: '_Ignored', type: 'property' },
      { text: 'RenderType', type: 'property' },
      { text: '#include', type: 'keyword' },
      { text: '#pragma', type: 'keyword' },
      { text: 'IGNORED', type: 'macro' },
    ]));
  });
});
