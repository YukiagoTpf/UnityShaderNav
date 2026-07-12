import { describe, expect, it } from 'vitest';
import { scanShaderLabLayout } from '../../../src/parser/shaderlab/layoutScanner';

describe('scanShaderLabLayout', () => {
  it('publishes direct scopes while treating complete program blocks as opaque', () => {
    const text = [
      'Shader "Layout/Test" {',
      '  Properties {',
      '    _Color ("brace }", Color) = (1, 1, 1, 1)',
      '  }',
      '  SubShader {',
      '    Tags { "Queue" = "Geometry" }',
      '    Pass {',
      '      Name "FORWARD"',
      '      Stencil {',
      '        Pass Replace',
      '      }',
      '      HLSLPROGRAM',
      '      float4 frag() : SV_Target { return 1; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const layout = scanShaderLabLayout(text);

    expect(layout.safe).toBe(true);
    expect(layout.lines[2].directScope).toBe('properties');
    expect(layout.lines[5].directScope).toBe('subshader');
    expect(layout.lines[7].directScope).toBe('pass');
    expect(layout.lines[9].directScope).toBeUndefined();
    expect(layout.lines.slice(11, 14).every((line) => line.protected)).toBe(true);
    expect(layout.scopes.find((scope) => scope.kind === 'pass')?.hasProgramBlock).toBe(true);
    expect(layout.structure.shaders[0].children[0].children[0].name).toBe('FORWARD');
  });

  it.each([
    ['unmatched brace', 'Shader "X" {\n}\n}'],
    ['unclosed brace', 'Shader "X" {\n  SubShader {\n}'],
    ['stray end marker', 'Shader "X" {\nENDHLSL\n}'],
    ['mismatched end marker', 'Shader "X" {\nCGPROGRAM\nENDHLSL\n}'],
    ['ambiguous marker', 'Shader "X" {\nHLSLPROGRAM extra\nENDHLSL\n}'],
    ['unterminated comment', 'Shader "X" {\n/* missing\n}'],
    ['unterminated string', 'Shader "X" {\n  Fallback "missing\n}'],
    ['stray comment close', 'Shader "X" {\n*/ SubShader {}\n}'],
  ])('marks %s as unsafe', (_name, text) => {
    expect(scanShaderLabLayout(text).safe).toBe(false);
  });

  it('keeps recognized scopes inside a Shader Category wrapper', () => {
    const layout = scanShaderLabLayout([
      'Shader "Category/Test" {',
      '  Category {',
      '    SubShader {',
      '      Pass {}',
      '    }',
      '  }',
      '}',
    ].join('\n'));

    expect(layout.safe).toBe(true);
    expect(layout.structure.shaders[0].children[0].kind).toBe('subshader');
    expect(layout.structure.shaders[0].children[0].children[0].kind).toBe('pass');
  });

  it.each([
    ['Pass in Properties', 'Shader "X" {\nProperties { Pass {} }\nSubShader {}\n}', 1, 0],
    ['SubShader in Pass', 'Shader "X" {\nSubShader { Pass { SubShader {} } }\n}', 1, 0],
    ['nested Shader', 'Shader "X" {\nShader "Nested" {}\nSubShader {}\n}', 1, 0],
    ['Pass in opaque Tags', 'Shader "X" {\nSubShader { Tags { Pass {} } }\n}', 1, 0],
  ])('rejects %s without publishing an invalid structure node', (
    _name,
    text,
    expectedSubShaders,
    expectedPasses,
  ) => {
    const layout = scanShaderLabLayout(text);
    expect(layout.safe).toBe(false);
    const published = JSON.stringify(layout.structure);
    expect((published.match(/"kind":"subshader"/g) ?? []).length).toBe(expectedSubShaders);
    expect((published.match(/"kind":"pass"/g) ?? []).length).toBe(expectedPasses);
  });

  it.each([
    ['top-level program', 'Shader "X" {\nHLSLPROGRAM\nENDHLSL\nSubShader {}\n}'],
    ['Properties program', 'Shader "X" {\nProperties {\nHLSLPROGRAM\nENDHLSL\n}\nSubShader {}\n}'],
    ['Properties include', 'Shader "X" {\nProperties {\nHLSLINCLUDE\nENDHLSL\n}\nSubShader {}\n}'],
  ])('rejects %s with an invalid direct owner', (_name, text) => {
    expect(scanShaderLabLayout(text).safe).toBe(false);
  });
});
