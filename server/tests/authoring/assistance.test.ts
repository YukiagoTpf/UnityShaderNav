import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../../src/analysis';
import {
  shaderLabColorPresentations,
  shaderLabDocumentColors,
  shaderLabIndentationEdits,
  shaderLabSnippetCompletions,
} from '../../src/authoring';

const uri = 'file:///project/Assets/Authoring.shader';

function position(text: string, needle: string, characterOffset = 0) {
  const offset = text.indexOf(needle);
  if (offset < 0) throw new Error(`missing ${needle}`);
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length + characterOffset };
}

function completions(text: string, needle: string, offset: number) {
  return shaderLabSnippetCompletions(
    analyzeDocument(uri, text),
    text,
    position(text, needle, offset),
    'shaderlab',
    uri,
  );
}

describe('ShaderLab snippets', () => {
  it('offers only the structures valid for the direct ShaderLab scope', () => {
    const text = [
      'Shader "Authoring/Test" {',
      '  Properties {',
      '    prop',
      '  }',
      '  SubShader {',
      '    pass',
      '    Pass {',
      '      vertex',
      '    }',
      '  }',
      '}',
    ].join('\n');

    expect(completions(text, 'prop', 4).map((item) => item.label)).toEqual([
      'property-color',
      'property-float',
      'property-range',
      'property-vector',
      'property-texture2d',
    ]);
    expect(completions(text, 'pass', 4).map((item) => item.label)).toEqual(['pass']);
    const program = completions(text, 'vertex', 6);
    expect(program.map((item) => item.label)).toEqual(['vertex-fragment-program']);
    expect(program[0].textEdit && 'newText' in program[0].textEdit
      ? program[0].textEdit.newText
      : '').toContain('#pragma fragment ${2:frag}');
  });

  it('refuses comments, wrong scopes, malformed layout, and Passes with a program', () => {
    const existing = [
      'Shader "Authoring/Test" {',
      '  // prop',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 frag() : SV_Target { return 1; }',
      '      ENDHLSL',
      '      vertex',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(completions(existing, 'prop', 4)).toEqual([]);
    expect(completions(existing, 'vertex', 6)).toEqual([]);
    expect(completions('Shader "X" {\n  Properties {\n    prop', 'prop', 4)).toEqual([]);
  });

  it('allows a program snippet after a Pass-local include block', () => {
    const text = [
      'Shader "Authoring/Include" {',
      '  SubShader {',
      '    Pass {',
      '      HLSLINCLUDE',
      '      float Shared(float value) { return value; }',
      '      ENDHLSL',
      '      vertex',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(completions(text, 'vertex', 6).map((item) => item.label)).toEqual([
      'vertex-fragment-program',
    ]);
  });
});

describe('ShaderLab literal colors', () => {
  const text = [
    'Shader "Authoring/Colors" {',
    '  Properties {',
    '    _Color ("Color", Color) = (0.25, .5, 1, 0.75)',
    '    [HDR] _Hdr ("HDR", Color) = (0.25, 0.5, 1, 1)',
    '    _Vector ("Vector", Vector) = (0.25, 0.5, 1, 1)',
    '    _Bright ("Bright", Color) = (2, 0.5, 1, 1)',
    '    _Same ("(1, 0, 0, 1)", Color) = (1, 0, 0, 1)',
    '  }',
    '  SubShader {}',
    '}',
  ].join('\n');

  it('exposes only normalized non-HDR Color defaults', () => {
    const analysis = analyzeDocument(uri, text);
    const colors = shaderLabDocumentColors(analysis);
    expect(colors).toHaveLength(2);
    expect(colors[0]).toEqual(expect.objectContaining({
      color: { red: 0.25, green: 0.5, blue: 1, alpha: 0.75 },
    }));
    const sameLine = text.split('\n').findIndex((line) => line.includes('_Same'));
    const defaultStart = text.split('\n')[sameLine].lastIndexOf('(1, 0, 0, 1)');
    expect(colors[1].range).toEqual({
      start: { line: sameLine, character: defaultStart },
      end: { line: sameLine, character: defaultStart + '(1, 0, 0, 1)'.length },
    });
  });

  it('returns one tuple edit only for a current exact color range', () => {
    const analysis = analyzeDocument(uri, text);
    const [info] = shaderLabDocumentColors(analysis);
    const presentations = shaderLabColorPresentations(analysis, info.range, {
      red: 0.1,
      green: 0.2,
      blue: 0.3,
      alpha: 1,
    });
    expect(presentations).toEqual([{
      label: '(0.1, 0.2, 0.3, 1)',
      textEdit: {
        range: info.range,
        newText: '(0.1, 0.2, 0.3, 1)',
      },
    }]);
    expect(shaderLabColorPresentations(analysis, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    }, info.color)).toEqual([]);
  });

  it('keeps colors and formatting available for a SubShader Surface CGPROGRAM', () => {
    const surface = [
      'Shader "Authoring/Surface" {',
      '  Properties {',
      '    _Color ("Color", Color) = (1, 0, 0, 1)',
      '  }',
      '  SubShader {',
      '   CGPROGRAM',
      '   #pragma surface surf Standard',
      '   void surf() {}',
      '   ENDCG',
      '  }',
      '}',
    ].join('\n');
    const analysis = analyzeDocument(uri, surface)!;
    expect(analysis.layout.safe).toBe(true);
    expect(shaderLabDocumentColors(analysis)).toHaveLength(1);
    const edits = shaderLabIndentationEdits(analysis, surface, {
      tabSize: 2,
      insertSpaces: true,
    });
    expect(edits).not.toBeNull();
    expect(edits?.some((edit) => edit.range.start.line >= 5 && edit.range.start.line <= 8)).toBe(false);
  });
});

describe('ShaderLab indentation formatting', () => {
  it('is idempotent and never edits any byte of an embedded program block', () => {
    const text = [
      ' Shader "Authoring/Format"',
      '{',
      'Properties',
      '{',
      ' _Color ("Color", Color) = (1, 1, 1, 1)',
      '}',
      'SubShader',
      '{',
      'Pass',
      '{',
      '   HLSLPROGRAM',
      '\tfloat4 frag() : SV_Target {  return 1; }  ',
      ' ENDHLSL',
      '}',
      '}',
      '}',
    ].join('\r\n');
    const analysis = analyzeDocument(uri, text)!;
    const edits = shaderLabIndentationEdits(analysis, text, {
      tabSize: 2,
      insertSpaces: true,
    });
    expect(edits).not.toBeNull();
    expect(edits?.every((edit) => edit.range.start.character === 0)).toBe(true);
    expect(edits?.some((edit) => edit.range.start.line >= 10 && edit.range.start.line <= 12)).toBe(false);

    const formatted = applyLineEdits(text, edits!);
    expect(formatted.split('\r\n').slice(10, 13)).toEqual(text.split('\r\n').slice(10, 13));
    expect(formatted).toContain('    _Color');
    expect(shaderLabIndentationEdits(analyzeDocument(uri, formatted), formatted, {
      tabSize: 2,
      insertSpaces: true,
    })).toEqual([]);
  });

  it('refuses malformed structure', () => {
    const text = 'Shader "Broken" {\n  SubShader {\n';
    expect(shaderLabIndentationEdits(analyzeDocument(uri, text), text, {
      tabSize: 2,
      insertSpaces: true,
    })).toBeNull();
  });

  it.each([
    ['HLSLPROGRAM', 'ENDHLSL', 'pass'],
    ['CGPROGRAM', 'ENDCG', 'pass'],
    ['HLSLINCLUDE', 'ENDHLSL', 'subshader'],
    ['CGINCLUDE', 'ENDCG', 'subshader'],
  ] as const)('protects the complete %s block', (start, end, owner) => {
    const block = [`   ${start}`, '\tbody { keep; }  ', ` ${end}`];
    const body = owner === 'pass'
      ? ['SubShader {', 'Pass {', ...block, '}', '}']
      : ['SubShader {', ...block, '}'];
    const text = [' Shader "Protected/Test" {', ...body, '}'].join('\n');
    const edits = shaderLabIndentationEdits(analyzeDocument(uri, text), text, {
      tabSize: 2,
      insertSpaces: true,
    });
    expect(edits).not.toBeNull();
    const startLine = text.split('\n').findIndex((line) => line.includes(start));
    expect(edits?.some((edit) => (
      edit.range.start.line >= startLine && edit.range.start.line <= startLine + 2
    ))).toBe(false);
    expect(applyLineEdits(text, edits!).split('\n').slice(startLine, startLine + 3)).toEqual(block);
  });
});

function applyLineEdits(text: string, edits: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]): string {
  const ending = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const edit of edits) {
    const line = lines[edit.range.start.line];
    lines[edit.range.start.line] = edit.newText + line.slice(edit.range.end.character);
  }
  return lines.join(ending);
}
