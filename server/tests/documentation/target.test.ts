import { describe, expect, it } from 'vitest';
import { documentationTargetAt } from '../../src/documentation';
import { scanBlocks } from '../../src/parser/shaderlab/blockScanner';
import { scanShaderLabTokens } from '../../src/parser/shaderlab/tokenScanner';

function target(text: string, needle: string, languageId = 'shaderlab') {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`missing ${needle}`);
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  const position = { line: lines.length - 1, character: lines.at(-1)!.length };
  const tokens = languageId === 'shaderlab'
    ? scanShaderLabTokens(text, scanBlocks(text).blocks)
    : undefined;
  return documentationTargetAt(text, position, languageId, `file:///Doc.${languageId === 'hlsl' ? 'hlsl' : 'shader'}`, tokens);
}

describe('documentationTargetAt', () => {
  it('projects ShaderLab directives, render states, Property attributes and numeric-leading types', () => {
    const text = [
      'Shader "Docs/Test" {',
      '  Properties {',
      '    [HDR] _Color ("Color", Color) = (1,1,1,1)',
      '    _MainTex ("Texture", 2D) = "white" {}',
      '  }',
      '  SubShader { Cull Back Pass {} }',
      '}',
    ].join('\n');

    expect(target(text, 'Shader')).toMatchObject({ role: 'shaderLabTerm', name: 'Shader' });
    expect(target(text, 'Cull')).toMatchObject({ role: 'shaderLabTerm', name: 'Cull' });
    expect(target(text, 'HDR')).toMatchObject({ role: 'propertyAttribute', name: 'HDR' });
    expect(target(text, 'Color)')).toMatchObject({ role: 'propertyType', name: 'Color' });
    expect(target(text, '2D)')).toMatchObject({ role: 'propertyType', name: '2D' });
  });

  it('distinguishes semantics from ordinary identifiers and stays neutral in strings', () => {
    expect(target('float4 pos : SV_POSITION;', 'SV_POSITION', 'hlsl')).toMatchObject({
      role: 'semantic',
      name: 'SV_POSITION',
    });
    expect(target('float COLOR = 1;', 'COLOR', 'hlsl')).toMatchObject({
      role: 'hlslIdentifier',
      name: 'COLOR',
    });
    expect(target('Shader "Cull" {}', 'Cull')).toBeUndefined();
  });
});
