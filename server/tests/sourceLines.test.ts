import { TextDocument } from 'vscode-languageserver-textdocument';
import { describe, expect, it } from 'vitest';
import { analyzeDocument } from '../src/analysis/documentAnalysis';
import { splitSourceLines } from '../src/sourceLines';
import { exactSource } from '../src/sourceLocation';

/** The line model the client will use to interpret every position we report. */
function clientLines(text: string): string[] {
  const document = TextDocument.create('file:///project/Assets/L.shader', 'shaderlab', 1, text);
  return Array.from({ length: document.lineCount }, (_unused, line) => {
    const start = document.offsetAt({ line, character: 0 });
    const end = line + 1 < document.lineCount
      ? document.offsetAt({ line: line + 1, character: 0 })
      : text.length;
    return text.slice(start, end).replace(/\r\n$|[\r\n]$/, '');
  });
}

describe('splitSourceLines', () => {
  it('agrees with the client line model on every line terminator', () => {
    for (const text of [
      'Shader "A"\n{\n}\n',
      'Shader "A"\r\n{\r\n}\r\n',
      'Shader "A"\r{\r}\r',
      'Shader "A"\r\n{\n}\r',
      // A double-converted file: real projects contain these, and it is the
      // case where a /\r?\n/ split disagrees with the client.
      'Shader "A"\r\r\n{\r\r\n}\r\r\n',
      'Shader "A"',
      '',
    ]) {
      expect(splitSourceLines(text)).toStrictEqual(clientLines(text));
    }
  });

  it('counts a lone CR as a line terminator', () => {
    // Splitting on /\r?\n/ answers 2 lines here and puts a stray CR at the end
    // of the first, so every later line number names the wrong line.
    expect(splitSourceLines('a\r\r\nb\r\r\nc')).toStrictEqual(['a', '', 'b', '', 'c']);
  });

  it('keeps analysis line numbers usable by the client for CR-CR-LF sources', () => {
    // Authored with \r\r\n throughout, the shape found in a real project.
    const lines = [
      'Shader "Probe/DoubleConverted"',
      '{',
      '    SubShader',
      '    {',
      '        Pass',
      '        {',
      '            Name "Main"',
      '        }',
      '    }',
      '}',
    ];
    const text = `${lines.join('\r\r\n')}\r\r\n`;
    const uri = 'file:///project/Assets/Shaders/DoubleConverted.shader';

    const analysis = analyzeDocument(uri, text, 'full');
    if (!analysis) throw new Error('analysis is unavailable for a .shader document');

    expect(analysis.sourceLines).toStrictEqual(clientLines(text));
    // Every authored line must land where the client will look for it: the
    // blank lines the lone CRs introduce sit between them.
    const shader = analysis.structure.shaders[0];
    if (!shader) throw new Error('no Shader was scanned');
    expect(shader.headerLine).toBe(0);
    expect(analysis.sourceLines[shader.headerLine]).toBe(lines[0]);

    const subShader = shader.children.find(({ kind }) => kind === 'subshader');
    if (!subShader) throw new Error('no SubShader was scanned');
    expect(analysis.sourceLines[subShader.headerLine]?.trim()).toBe('SubShader');

    const pass = subShader.children.find(({ kind }) => kind === 'pass');
    if (!pass) throw new Error('no Pass was scanned');
    expect(analysis.sourceLines[pass.headerLine]?.trim()).toBe('Pass');
    expect(pass.name).toBe('Main');
  });

  it('reports exact source lines on the client line model', () => {
    const text = 'Shader "A"\r\r\n{\r\r\n}\r\r\n';
    expect(exactSource(text).sourceLines).toStrictEqual(clientLines(text));
  });
});
