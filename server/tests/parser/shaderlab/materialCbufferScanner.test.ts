import { describe, expect, it } from 'vitest';
import { scanBlocks } from '../../../src/parser/shaderlab/blockScanner';
import { scanShaderLabMaterialFacts } from '../../../src/parser/shaderlab/materialCbufferScanner';
import { scanStructure } from '../../../src/parser/shaderlab/structureScanner';

function scan(text: string) {
  return scanShaderLabMaterialFacts(text, scanBlocks(text).blocks, scanStructure(text));
}

describe('scanShaderLabMaterialFacts', () => {
  it('collects macro and native UnityPerMaterial layouts with insertion facts', () => {
    const text = [
      'Shader "Material/Facts" {',
      '  SubShader {',
      '    Tags { "RenderPipeline" = "UniversalPipeline" }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      CBUFFER_START(UnityPerMaterial)',
      '          float4 _BaseColor;',
      '          float _Smoothness : packoffset(c1.x);',
      '      CBUFFER_END',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      cbuffer UnityPerMaterial {',
      '          float4 _BaseColor;',
      '          float _Smoothness;',
      '      };',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const facts = scan(text);

    expect(facts.srpEvidence).toBe(true);
    expect(facts.programBlocks).toHaveLength(2);
    expect(facts.cbuffers).toHaveLength(2);
    expect(facts.cbuffers.map((entry) => ({
      name: entry.name,
      fields: entry.fields.map((field) => `${field.type} ${field.name}`),
      insertionLine: entry.insertionPosition.line,
      fieldIndent: entry.fieldIndent,
      complete: entry.complete,
      opaque: entry.opaque,
    }))).toEqual([
      {
        name: 'UnityPerMaterial',
        fields: ['float4 _BaseColor', 'float _Smoothness'],
        insertionLine: 8,
        fieldIndent: '          ',
        complete: true,
        opaque: false,
      },
      {
        name: 'UnityPerMaterial',
        fields: ['float4 _BaseColor', 'float _Smoothness'],
        insertionLine: 16,
        fieldIndent: '          ',
        complete: true,
        opaque: false,
      },
    ]);
    expect(facts.cbuffers[0].fields[1].packOffset).toBe('c1.x');
  });

  it('recognizes SRP includes and marks conditional or incomplete layouts unsafe', () => {
    const text = [
      'Shader "Material/Conditional" {',
      '  HLSLINCLUDE',
      '  #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '  CBUFFER_START(UnityPerMaterial)',
      '  #if USE_TINT',
      '      half4 _Tint;',
      '  #endif',
      '  ENDHLSL',
      '}',
    ].join('\n');

    const facts = scan(text);

    expect(facts.srpEvidence).toBe(true);
    expect(facts.cbuffers).toEqual([
      expect.objectContaining({
        conditional: true,
        opaque: false,
        complete: false,
        insertionPosition: { line: 7, character: 0 },
        fields: [expect.objectContaining({ name: '_Tint', conditional: true })],
      }),
    ]);
  });

  it('preserves array layout and marks macro-generated fields opaque', () => {
    const text = [
      'Shader "Material/Opaque" {',
      '  HLSLPROGRAM',
      '  CBUFFER_START(UnityPerMaterial)',
      '      float4 _Colors [ 2 ];',
      '      DECLARE_MATERIAL_FIELDS()',
      '  CBUFFER_END',
      '  ENDHLSL',
      '}',
    ].join('\n');

    expect(scan(text).cbuffers[0]).toMatchObject({
      opaque: true,
      fields: [expect.objectContaining({ type: 'float4[2]', name: '_Colors' })],
    });
  });

  it('collects every declarator with exact ranges', () => {
    const text = [
      'Shader "Material/Declarators" {',
      '  HLSLPROGRAM',
      '  CBUFFER_START(UnityPerMaterial)',
      '    float4 _Color, _SpecColor;',
      '    StructuredBuffer<Foo> Foo;',
      '  CBUFFER_END',
      '  ENDHLSL',
      '}',
    ].join('\n');

    const cbuffer = scan(text).cbuffers[0];

    expect(cbuffer).toMatchObject({
      complete: true,
      opaque: false,
      fields: [
        { type: 'float4', name: '_Color' },
        { type: 'float4', name: '_SpecColor' },
        { type: 'StructuredBuffer<Foo>', name: 'Foo' },
      ],
    });
    expect(cbuffer.fields.map((field) => (
      text.split('\n')[field.nameRange.start.line].slice(
        field.nameRange.start.character,
        field.nameRange.end.character,
      )
    ))).toEqual(['_Color', '_SpecColor', 'Foo']);
    expect(cbuffer.fields[2].nameRange.start.character).toBeGreaterThan(
      text.split('\n')[4].indexOf('Foo'),
    );
  });

  it('collects inline native fields and ignores directive-line block comments', () => {
    const inline = [
      'Shader "Material/Inline" {',
      '  HLSLPROGRAM',
      '  cbuffer UnityPerMaterial { float4 _Color; };',
      '  ENDHLSL',
      '}',
    ].join('\n');
    expect(scan(inline).cbuffers[0]).toMatchObject({
      complete: true,
      opaque: false,
      fields: [{ type: 'float4', name: '_Color' }],
    });

    const comment = [
      'Shader "Material/CommentState" {',
      '  HLSLPROGRAM /*',
      '  CBUFFER_START(UnityPerMaterial)',
      '  float4 _Fake;',
      '  CBUFFER_END',
      '  */',
      '  ENDHLSL',
      '}',
    ].join('\n');
    expect(scan(comment).cbuffers).toEqual([]);
  });

  it('treats angle-bracket and include_with_pragmas forms as unseen declaration sources', () => {
    const text = [
      'Shader "Material/PragmaInclude" {',
      '  HLSLPROGRAM',
      '  #include <Local.hlsl>',
      '  #include_with_pragmas "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"',
      '  ENDHLSL',
      '}',
    ].join('\n');

    expect(scan(text)).toMatchObject({
      srpEvidence: true,
      hasIncludes: true,
    });
  });

  it('ignores tags, includes, and cbuffer text inside comments', () => {
    const text = [
      'Shader "Material/Comments" {',
      '  // Tags { "RenderPipeline" = "UniversalPipeline" }',
      '  HLSLPROGRAM',
      '  /* #include "Packages/com.unity.render-pipelines.fake/Core.hlsl" */',
      '  // CBUFFER_START(UnityPerMaterial)',
      '  ENDHLSL',
      '}',
    ].join('\n');

    expect(scan(text)).toMatchObject({ srpEvidence: false, cbuffers: [] });
  });
});
