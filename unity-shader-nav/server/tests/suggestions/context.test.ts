import { describe, expect, it } from 'vitest';
import { suggestionContextAt } from '../../src/suggestions';

function ctx(text: string, line: number, character: number, languageId = 'hlsl', uri = 'file:///t/test.hlsl') {
  return suggestionContextAt(text, { line, character }, languageId, uri);
}

describe('suggestionContextAt', () => {
  it('classifies hlsl and shaderlab code regions', () => {
    expect(ctx('float4 main() { return 0; }', 0, 7).kind).toBe('hlslCode');

    const shader = [
      'Shader "T/Test" {',
      '  Properties { _Color ("Color", Float) = 1 }',
      '  SubShader { Pass {',
      '    HLSLPROGRAM',
      '    float4 main() { return 0; }',
      '    ENDHLSL',
      '  } }',
      '}',
    ].join('\n');

    expect(ctx(shader, 4, 12, 'shaderlab', 'file:///t/test.shader').kind).toBe('hlslCode');
    expect(ctx(shader, 1, 6, 'shaderlab', 'file:///t/test.shader').kind).toBe('shaderLabCode');
  });

  it('rejects comments and string literals', () => {
    expect(ctx('// helper', 0, 4).kind).toBe('comment');
    expect(ctx('float4 main() { return "helper"; }', 0, 25).kind).toBe('string');
    expect(ctx('/*\n helper\n*/', 1, 2).kind).toBe('comment');
  });

  it('detects ordinary prefixes and empty whitespace prefixes', () => {
    expect(ctx('float4 main() { return Lig', 0, 26).prefix.text).toBe('Lig');
    expect(ctx('float4 main() { return ', 0, 23).prefix.text).toBe('');
  });

  it('distinguishes semantic positions from ternary expressions', () => {
    const semanticText = 'struct V { float4 positionCS : SV_';
    const semantic = ctx(semanticText, 0, semanticText.length);
    expect(semantic.kind).toBe('semanticPosition');
    expect(semantic.prefix.text).toBe('SV_');

    const ternaryText = 'float4 main(bool useA) { return useA ? a : nor';
    const ternary = ctx(ternaryText, 0, ternaryText.length);
    expect(ternary.kind).toBe('hlslCode');
    expect(ternary.prefix.text).toBe('nor');
  });

  it('detects member receivers and member prefixes', () => {
    const afterDot = ctx('float3 c = surface.', 0, 19);
    expect(afterDot.member).toMatchObject({
      receiver: 'surface',
      memberPrefix: { text: '' },
    });

    const partial = ctx('float3 c = surface.pos', 0, 22);
    expect(partial.member).toMatchObject({
      receiver: 'surface',
      memberPrefix: { text: 'pos' },
    });

    expect(ctx('float3 c = lights[i].', 0, 21).member?.receiver).toBe('lights[i]');
    expect(ctx('float r = surface.brdfData.', 0, 27).member?.receiver).toBe('surface.brdfData');
  });
});
