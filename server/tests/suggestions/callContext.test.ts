import { describe, expect, it } from 'vitest';
import type { ExactSource } from '../../src/sourceLocation';
import { callContextAt, suggestionContextAt } from '../../src/suggestions';

function call(text: string, character: number) {
  return callContextAt(text, { line: 0, character });
}

describe('callContextAt', () => {
  it('finds a free call from a later argument line', () => {
    const text = [
      'float4 c = Lighting(',
      '  normalWS,',
      '  roughness',
    ].join('\n');

    expect(callContextAt(text, { line: 2, character: 11 })).toMatchObject({
      target: {
        kind: 'free',
        name: 'Lighting',
        range: {
          start: { line: 0, character: 11 },
          end: { line: 0, character: 19 },
        },
      },
      argumentListStart: { line: 0, character: 20 },
      activeParameter: 1,
    });
  });

  it('ignores call punctuation inside a cross-line block comment', () => {
    const text = [
      'float4 c = Lighting(',
      '  normalWS,',
      '  /* Fake, ) ( */',
      '  roughness',
    ].join('\n');

    expect(callContextAt(text, { line: 3, character: 11 })).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
      activeParameter: 1,
    });
  });

  it('skips grouping parentheses while finding the enclosing call', () => {
    const text = [
      'float4 c = Lighting(',
      '  (normalWS + tangentWS',
    ].join('\n');

    expect(callContextAt(text, { line: 1, character: 23 })).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
      activeParameter: 0,
    });
  });

  it('ignores strings and nested-call commas across lines', () => {
    const text = [
      'float4 c = Lighting(',
      '  "fake, ) (",',
      '  nested(1, 2),',
      '  roughness',
    ].join('\n');

    expect(callContextAt(text, { line: 3, character: 11 })).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
      activeParameter: 2,
    });
  });

  it('fails closed when the call open is outside the bounded scan window', () => {
    const text = ['Lighting(', ...Array.from({ length: 128 }, () => '  value')].join('\n');

    expect(callContextAt(text, { line: 128, character: 7 })).toBeNull();
  });

  it('fails closed when the call open is beyond the character budget', () => {
    const text = `Lighting(${'x'.repeat(32 * 1024)}`;

    expect(call(text, text.length)).toBeNull();
  });

  it('bounds a prepared 4 MiB source to the local call window', () => {
    const lines = Array.from(
      { length: 4_096 },
      (_, index) => index < 3_968
        ? 'float value;'.padEnd(1_056, ' ')
        : 'float value;',
    );
    lines[lines.length - 1] = 'Lighting(';
    let lineReads = 0;
    const countedLines = new Proxy(lines, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) lineReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const source: ExactSource = {
      sourceText: lines.join('\n'),
      sourceLines: countedLines,
      sourceBlockCommentStates: lines.map(() => false),
    };

    expect(callContextAt(source, { line: lines.length - 1, character: 9 })).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
    });
    expect(lineReads).toBeLessThanOrEqual(130);
  });

  it('uses prepared lexical facts for calls beyond the unprepared synchronization window', () => {
    const lines = Array.from({ length: 256 }, () => 'float value;');
    lines[lines.length - 1] = 'Lighting(';
    const source: ExactSource = {
      sourceText: lines.join('\n'),
      sourceLines: lines,
      sourceBlockCommentStates: lines.map(() => false),
    };

    expect(callContextAt(source, { line: lines.length - 1, character: 9 })).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
      activeParameter: 0,
    });
  });

  it('describes a member call target without losing its receiver', () => {
    const text = 'float4 c = surface.brdf.Shade(';

    expect(call(text, text.length)).toMatchObject({
      target: {
        kind: 'member',
        receiver: 'surface.brdf',
        name: 'Shade',
        range: {
          start: { line: 0, character: 24 },
          end: { line: 0, character: 29 },
        },
      },
      activeParameter: 0,
    });
  });

  it('detects a call and first active parameter', () => {
    expect(call('float4 c = Lighting(', 20)).toMatchObject({
      target: {
        kind: 'free',
        name: 'Lighting',
        range: {
          start: { line: 0, character: 11 },
          end: { line: 0, character: 19 },
        },
      },
      activeParameter: 0,
      argumentListStart: { line: 0, character: 20 },
    });
  });

  it('counts top-level commas for active parameter', () => {
    expect(call('float4 c = Lighting(normalWS, ', 29)?.activeParameter).toBe(1);
  });

  it('ignores nested call commas', () => {
    expect(call('float4 c = Lighting(float3(0, 1, 0), roughness', 46)?.activeParameter).toBe(1);
  });

  it('handles empty calls at a position inside parentheses', () => {
    expect(call('float4 c = Lighting()', 20)?.activeParameter).toBe(0);
  });

  it('rejects positions outside calls', () => {
    expect(call('float4 c = Lighting', 19)).toBeNull();
  });

  it('rejects function declarations', () => {
    expect(callContextAt(
      'float4 Lighting(float3 n, half r) { return 1; }',
      { line: 0, character: 30 },
    )).toBeNull();
  });

  it('rejects a function declaration whose return type is on the previous line', () => {
    const text = [
      'float4',
      'Lighting(',
      '  float3 normalWS,',
    ].join('\n');

    expect(callContextAt(text, { line: 2, character: 18 })).toBeNull();
  });

  it('rejects inline and qualified struct method declarations', () => {
    const inline = [
      'struct Surface {',
      '  float Shade(',
      '    float x,',
    ].join('\n');
    const qualified = 'float Surface::Shade(float x) { return x; }';

    expect(callContextAt(inline, { line: 2, character: 12 })).toBeNull();
    expect(callContextAt(qualified, { line: 0, character: 28 })).toBeNull();
  });

  it('accepts calls after return keywords', () => {
    expect(callContextAt(
      'float4 main() { return Lighting(',
      { line: 0, character: 32 },
    )).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
      activeParameter: 0,
    });
  });

  it('accepts calls after else and do control prefixes', () => {
    expect(callContextAt('else Lighting(', { line: 0, character: 14 })).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
    });
    const multiline = ['do', '  Lighting(', '    value'].join('\n');
    expect(callContextAt(multiline, { line: 2, character: 9 })).toMatchObject({
      target: { kind: 'free', name: 'Lighting' },
      activeParameter: 0,
    });
  });

  it('combines with suggestion context to reject comments and strings', () => {
    const comment = '// Lighting(';
    const commentPosition = { line: 0, character: comment.length };
    expect(suggestionContextAt(comment, commentPosition, 'hlsl', 'file:///t/test.hlsl').kind).toBe('comment');
    expect(callContextAt(comment, commentPosition)).toBeNull();

    const string = 'float4 c = "Lighting(";';
    const stringPosition = { line: 0, character: 21 };
    expect(suggestionContextAt(string, stringPosition, 'hlsl', 'file:///t/test.hlsl').kind).toBe('string');
    expect(callContextAt(string, stringPosition)).toBeNull();
  });

  it('rejects a cursor on the second slash of a line-comment delimiter', () => {
    expect(callContextAt('Lighting(//x', { line: 0, character: 10 })).toBeNull();
  });

  it('rejects a cursor on the star of a block-comment opener', () => {
    expect(callContextAt('Lighting(/*x', { line: 0, character: 10 })).toBeNull();
  });

  it('rejects a cursor on an opening string quote', () => {
    expect(callContextAt('Lighting("x', { line: 0, character: 9 })).toBeNull();
  });

  it('preserves cursor delimiter classification with published line-entry states', () => {
    for (const [text, character] of [
      ['Lighting(//x', 10],
      ['Lighting(/*x', 10],
      ['Lighting("x', 9],
    ] as const) {
      const source: ExactSource = {
        sourceText: text,
        sourceLines: [text],
        sourceBlockCommentStates: [false],
      };
      expect(callContextAt(source, { line: 0, character })).toBeNull();
    }
  });
});
