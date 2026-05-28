import { describe, expect, it } from 'vitest';
import { scanProperties } from '../../../src/parser/shaderlab/propertiesScanner';

function shader(...lines: string[]): string {
  return lines.join('\n');
}

describe('scanProperties', () => {
  it('returns [] for an empty file', () => {
    expect(scanProperties('')).toEqual([]);
  });

  it('returns [] when there is no Properties block', () => {
    const text = shader(
      'Shader "Test/NoProperties" {',
      '  SubShader {',
      '    Pass {}',
      '  }',
      '}',
    );
    expect(scanProperties(text)).toEqual([]);
  });

  it('returns [] for a shader with HLSL blocks but no Properties block', () => {
    const text = shader(
      'Shader "Test/HlslOnly" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 _BaseColor;',
      '      void frag() {}',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    );
    expect(scanProperties(text)).toEqual([]);
  });

  it('scans Properties block with brace on the next line (Unity-style)', () => {
    // Unity's default shader templates often put the opening brace on its
    // own line. Without sticky pendingPropertiesOpen handling, the standalone
    // `{` line would not be counted into propertiesDepth and the body would
    // be silently dropped.
    const text = shader(
      'Shader "Test/BraceNextLine" {',
      '  Properties',
      '  {',
      '    _MainTex ("Base Map", 2D) = "white" {}',
      '    _BaseColor ("Tint", Color) = (1,1,1,1)',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries.map((e) => e.name)).toEqual(['_MainTex', '_BaseColor']);
    expect(entries[0].type).toBe('2D');
    expect(entries[1].type).toBe('Color');
  });

  it('scans a single _MainTex declaration', () => {
    const text = shader(
      'Shader "Test/Single" {',
      '  Properties {',
      '    _MainTex ("Base Map", 2D) = "white" {}',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.name).toBe('_MainTex');
    expect(entry.type).toBe('2D');

    const propLine = '    _MainTex ("Base Map", 2D) = "white" {}';
    const nameStart = propLine.indexOf('_MainTex');
    expect(entry.nameRange).toEqual({
      start: { line: 2, character: nameStart },
      end: { line: 2, character: nameStart + '_MainTex'.length },
    });
    expect(entry.declarationRange).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 2, character: propLine.length },
    });
  });

  it('scans multiple properties and exposes accurate name ranges', () => {
    const text = shader(
      'Shader "Test/Multi" {',
      '  Properties {',
      '    _MainTex ("Base Map", 2D) = "white" {}',
      '    _BaseColor ("Tint", Color) = (1,1,1,1)',
      '    _Roughness ("Roughness", Range(0, 1)) = 0.5',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries.map((e) => e.name)).toEqual([
      '_MainTex',
      '_BaseColor',
      '_Roughness',
    ]);
    expect(entries.map((e) => e.type)).toEqual(['2D', 'Color', 'Range']);
    expect(entries[0].nameRange.start.line).toBe(2);
    expect(entries[1].nameRange.start.line).toBe(3);
    expect(entries[2].nameRange.start.line).toBe(4);
  });

  it('recognises every whitelisted type', () => {
    const text = shader(
      'Shader "Test/Types" {',
      '  Properties {',
      '    _A ("A", Color) = (1,1,1,1)',
      '    _B ("B", Vector) = (0,0,0,0)',
      '    _C ("C", Float) = 0',
      '    _D ("D", Range(0, 1)) = 0.5',
      '    _E ("E", Int) = 0',
      '    _F ("F", 3D) = "white" {}',
      '    _G ("G", Cube) = "white" {}',
      '    _H ("H", CubeArray) = "white" {}',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['_A', 'Color'],
      ['_B', 'Vector'],
      ['_C', 'Float'],
      ['_D', 'Range'],
      ['_E', 'Int'],
      ['_F', '3D'],
      ['_G', 'Cube'],
      ['_H', 'CubeArray'],
    ]);
  });

  it('handles a single leading decorator', () => {
    const text = shader(
      'Shader "Test/Deco" {',
      '  Properties {',
      '    [HDR] _Color ("Tint", Color) = (1,1,1,1)',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.name).toBe('_Color');
    const line = '    [HDR] _Color ("Tint", Color) = (1,1,1,1)';
    const nameStart = line.indexOf('_Color');
    expect(entry.nameRange.start.character).toBe(nameStart);
    expect(entry.nameRange.start.character).toBeGreaterThan(line.indexOf('['));
  });

  it('handles multiple leading decorators', () => {
    const text = shader(
      'Shader "Test/Decos" {',
      '  Properties {',
      '    [NoScaleOffset] [HDR] _Tex ("T", 2D) = "white" {}',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries).toHaveLength(1);
    const line = '    [NoScaleOffset] [HDR] _Tex ("T", 2D) = "white" {}';
    expect(entries[0].name).toBe('_Tex');
    expect(entries[0].nameRange.start.character).toBe(line.indexOf('_Tex'));
  });

  it('ignores property-shaped content inside line and block comments', () => {
    const text = shader(
      'Shader "Test/Comments" {',
      '  Properties {',
      '    // _Fake ("Fake", 2D) = "white" {}',
      '    /* _AlsoFake ("AlsoFake", Color) = (1,1,1,1) */',
      '    _Real ("Real", Float) = 0',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries.map((e) => e.name)).toEqual(['_Real']);
  });

  it('does not crash on an HLSL block embedded between property lines', () => {
    const text = shader(
      'Shader "Test/MixedHlsl" {',
      '  Properties {',
      '    _Before ("Before", Float) = 0',
      '    HLSLPROGRAM',
      '    float _Junk;',
      '    ENDHLSL',
      '    _After ("After", Float) = 1',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    // The HLSL content line is skipped; the two real properties are kept.
    expect(entries.map((e) => e.name)).toEqual(['_Before', '_After']);
  });

  it('omits malformed declarations without throwing', () => {
    const text = shader(
      'Shader "Test/Malformed" {',
      '  Properties {',
      '    _MissingComma ("Bad" 2D) = 0',
      '    _MissingParen ("Bad", 2D = 0',
      '    _Good ("Good", Float) = 0',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries.map((e) => e.name)).toEqual(['_Good']);
  });

  it('emits two entries for a duplicated name', () => {
    const text = shader(
      'Shader "Test/Dup" {',
      '  Properties {',
      '    _Main ("A", Float) = 0',
      '    _Main ("B", Float) = 1',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('_Main');
    expect(entries[1].name).toBe('_Main');
    expect(entries[0].nameRange.start.line).toBe(2);
    expect(entries[1].nameRange.start.line).toBe(3);
  });

  it('does not pick up identifiers after the Properties block closes', () => {
    const text = shader(
      'Shader "Test/Close" {',
      '  Properties {',
      '    _Inside ("In", Float) = 0',
      '  }',
      '  SubShader {',
      '    _Outside ("Out", Float) = 0',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries.map((e) => e.name)).toEqual(['_Inside']);
  });

  it('handles CRLF line endings without including the carriage return in the declaration range', () => {
    const propLine = '    _MainTex ("Base Map", 2D) = "white" {}';
    const text = [
      'Shader "Test/CRLF" {',
      '  Properties {',
      propLine,
      '  }',
      '}',
    ].join('\r\n');
    const entries = scanProperties(text);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.name).toBe('_MainTex');
    expect(entry.type).toBe('2D');
    expect(entry.declarationRange.end.character).toBe(propLine.length);
    expect(entry.nameRange).toEqual({
      start: { line: 2, character: propLine.indexOf('_MainTex') },
      end: { line: 2, character: propLine.indexOf('_MainTex') + '_MainTex'.length },
    });
  });

  it('accepts a non-ASCII display name', () => {
    const text = shader(
      'Shader "Test/Unicode" {',
      '  Properties {',
      '    _MainTex ("テクスチャ", 2D) = "white" {}',
      '  }',
      '}',
    );
    const entries = scanProperties(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('_MainTex');
    expect(entries[0].type).toBe('2D');
  });
});

