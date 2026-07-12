import { describe, expect, it } from 'vitest';
import { scanBlocks } from '../../../src/parser/shaderlab/blockScanner';
import { scanShaderLabNames } from '../../../src/parser/shaderlab/nameScanner';
import { scanStructure } from '../../../src/parser/shaderlab/structureScanner';

function scan(text: string) {
  return scanShaderLabNames(text, scanBlocks(text).blocks, scanStructure(text));
}

describe('scanShaderLabNames', () => {
  it('collects exact Shader, Pass, Fallback, and UsePass name ranges', () => {
    const text = [
      'Shader "Examples/Uses" {',
      '  SubShader {',
      '    Pass { Name "ForwardLit" }',
      '    UsePass "Examples/Source/SHADOWCASTER"',
      '  }',
      '  Fallback "Examples/Fallback"',
      '}',
    ].join('\n');

    expect(scan(text)).toEqual({
      shaders: [{
        name: 'Examples/Uses',
        nameRange: { start: { line: 0, character: 8 }, end: { line: 0, character: 21 } },
        declarationRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } },
      }],
      passes: [{
        shaderName: 'Examples/Uses',
        name: 'ForwardLit',
        canonicalName: 'FORWARDLIT',
        nameRange: { start: { line: 2, character: 17 }, end: { line: 2, character: 27 } },
        declarationRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 30 } },
      }],
      references: [
        {
          kind: 'usePass',
          shaderName: 'Examples/Source',
          passName: 'SHADOWCASTER',
          canonicalPassName: 'SHADOWCASTER',
          shaderNameRange: { start: { line: 3, character: 13 }, end: { line: 3, character: 28 } },
          passNameRange: { start: { line: 3, character: 29 }, end: { line: 3, character: 41 } },
          directiveRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 42 } },
        },
        {
          kind: 'fallback',
          shaderName: 'Examples/Fallback',
          shaderNameRange: { start: { line: 5, character: 12 }, end: { line: 5, character: 29 } },
          directiveRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 30 } },
        },
      ],
    });
  });

  it('ignores comments, HLSL strings, malformed UsePass paths, and Fallback Off', () => {
    const text = [
      'Shader "Real" {',
      '  // Fallback "Fake"',
      '  SubShader {',
      '    Pass {',
      '      Name "RealPass"',
      '      HLSLPROGRAM',
      '      const char* fake = "UsePass \\"Fake/PASS\\"";',
      '      ENDHLSL',
      '    }',
      '    UsePass "MissingSlash"',
      '  }',
      '  Fallback Off',
      '}',
    ].join('\n');

    expect(scan(text)).toMatchObject({
      shaders: [{ name: 'Real' }],
      passes: [{ name: 'RealPass' }],
      references: [],
    });
  });
});
