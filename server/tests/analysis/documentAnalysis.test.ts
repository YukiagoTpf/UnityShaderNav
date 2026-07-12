import { describe, expect, it } from 'vitest';
import {
  analysisMatchesSource,
  analyzeDocument,
  type DocumentAnalysis,
} from '../../src/analysis';
import { indexFile } from '../../src/parser/hlsl';

const uri = 'file:///project/Assets/Shared.shader';
const source = [
  'Shader "Tests/Shared" {',
  '  Properties {',
  '    _FirstProperty ("First", Float) = 0',
  '  }',
    '  SubShader {',
    '    Pass {',
    '      Name "FirstPass"',
    '      HLSLPROGRAM',
  '      float4 FirstFunction() : SV_Target { return 0; }',
  '      ENDHLSL',
  '    }',
  '  }',
  '}',
].join('\n');

function tokenTexts(text: string, analysis: DocumentAnalysis): Array<{
  text: string;
  type: string;
}> {
  const lines = text.split(/\r?\n/);
  return (analysis.lexicalTokens ?? []).map((token) => ({
    text: lines[token.range.start.line].slice(
      token.range.start.character,
      token.range.end.character,
    ),
    type: token.tokenType,
  }));
}

describe('Document analysis', () => {
  it('serves index and full demands from the same ShaderLab block facts', async () => {
    const indexAnalysis = analyzeDocument(uri, source, 'index');
    const fullAnalysis = analyzeDocument(uri, source, 'full');

    expect(indexAnalysis).toBeDefined();
    expect(fullAnalysis).toBeDefined();
    expect(indexAnalysis!.blocks).toEqual(fullAnalysis!.blocks);
    expect(indexAnalysis!.structure).toEqual(fullAnalysis!.structure);
    expect(indexAnalysis!.shaderLabNames).toEqual(fullAnalysis!.shaderLabNames);
    expect(indexAnalysis!.shaderLabMaterial).toEqual(fullAnalysis!.shaderLabMaterial);
    expect(indexAnalysis!.blocks).toMatchObject([{
      kind: 'HLSLPROGRAM',
      contentStartLine: 8,
      contentEndLine: 8,
      unterminated: false,
    }]);
    expect(indexAnalysis!.structure.shaders[0].children[0].children[0])
      .toMatchObject({ name: 'FirstPass', headerLine: 5, closeLine: 10 });
    expect(indexAnalysis!.shaderLabNames).toMatchObject({
      shaders: [{ name: 'Tests/Shared' }],
      passes: [{ shaderName: 'Tests/Shared', name: 'FirstPass', canonicalName: 'FIRSTPASS' }],
    });
    expect(indexAnalysis!.lexicalTokens).toBeUndefined();
    expect(tokenTexts(source, fullAnalysis!)).toEqual(expect.arrayContaining([
      { text: 'Shader', type: 'keyword' },
      { text: '_FirstProperty', type: 'property' },
      { text: 'Float', type: 'type' },
      { text: 'HLSLPROGRAM', type: 'keyword' },
      { text: 'SV_Target', type: 'enumMember' },
      { text: 'ENDHLSL', type: 'keyword' },
    ]));

    const index = await indexFile(uri, source, undefined, indexAnalysis);
    expect(index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'FirstFunction', kind: 'function' }),
    ]));
    expect(index.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '_FirstProperty', type: 'Float' }),
    ]));
    expect(index.structure).toBe(indexAnalysis!.structure);
    expect(index.shaderLabNames).toBe(indexAnalysis!.shaderLabNames);
    expect(index.shaderLabMaterial).toBe(indexAnalysis!.shaderLabMaterial);
  });

  it('matches only the exact source text and regenerates stale prepared facts', async () => {
    const first = analyzeDocument(uri, source, 'full')!;
    const replacementSource = source
      .replaceAll('FirstProperty', 'ReplacementProperty')
      .replaceAll('FirstFunction', 'ReplacementFunction')
      .replaceAll('FirstPass', 'ReplacementPass');
    const replacement = analyzeDocument(uri, replacementSource, 'full')!;

    expect(analysisMatchesSource(first, source)).toBe(true);
    expect(analysisMatchesSource(first, replacementSource)).toBe(false);
    expect(analysisMatchesSource(replacement, replacementSource)).toBe(true);
    expect(replacement).not.toBe(first);
    expect(tokenTexts(replacementSource, replacement)).toContainEqual({
      text: '_ReplacementProperty',
      type: 'property',
    });
    expect(tokenTexts(replacementSource, replacement)).not.toContainEqual({
      text: '_FirstProperty',
      type: 'property',
    });

    const replacementIndex = await indexFile(uri, replacementSource, undefined, first);
    expect(replacementIndex.symbols.some((symbol) => (
      symbol.name === 'ReplacementFunction'
    ))).toBe(true);
    expect(replacementIndex.symbols.some((symbol) => symbol.name === 'FirstFunction')).toBe(false);
    expect(replacementIndex.structure?.shaders[0].children[0].children[0].name)
      .toBe('ReplacementPass');
  });

  it('deep-freezes every shared block and lexical-token value', () => {
    const analysis = analyzeDocument(uri, source, 'full')!;
    const block = analysis.blocks[0];
    const token = analysis.lexicalTokens![0];
    const shader = analysis.structure.shaders[0];
    const pass = shader.children[0].children[0];

    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.blocks)).toBe(true);
    expect(Object.isFrozen(block)).toBe(true);
    expect(Object.isFrozen(analysis.structure)).toBe(true);
    expect(Object.isFrozen(analysis.structure.shaders)).toBe(true);
    expect(Object.isFrozen(shader)).toBe(true);
    expect(Object.isFrozen(shader.children)).toBe(true);
    expect(Object.isFrozen(pass)).toBe(true);
    expect(Object.isFrozen(analysis.lexicalTokens)).toBe(true);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.range)).toBe(true);
    expect(Object.isFrozen(token.range.start)).toBe(true);
    expect(Object.isFrozen(token.range.end)).toBe(true);
    expect(Object.isFrozen(analysis.shaderLabNames)).toBe(true);
    expect(Object.isFrozen(analysis.shaderLabNames.shaders)).toBe(true);
    expect(Object.isFrozen(analysis.shaderLabMaterial)).toBe(true);
    expect(Object.isFrozen(analysis.shaderLabMaterial.programBlocks)).toBe(true);
  });

  it.each([
    'file:///project/Assets/Plain.hlsl',
    'file:///project/Assets/Kernel.compute',
    'untitled:Plain.cginc',
  ])('does not manufacture shared ShaderLab facts for %s', (nonShaderUri) => {
    expect(analyzeDocument(nonShaderUri, source, 'full')).toBeUndefined();
    expect(analyzeDocument(nonShaderUri, source, 'index')).toBeUndefined();
  });
});
