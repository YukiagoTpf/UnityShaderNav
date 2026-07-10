import { describe, expect, it } from 'vitest';
import { callContextAt, suggestionContextAt } from '../../src/suggestions';

function call(text: string, character: number) {
  return callContextAt(text, { line: 0, character });
}

describe('callContextAt', () => {
  it('detects a call and first active parameter', () => {
    expect(call('float4 c = Lighting(', 20)).toMatchObject({
      calleeName: 'Lighting',
      activeParameter: 0,
      calleeRange: {
        start: { line: 0, character: 11 },
        end: { line: 0, character: 19 },
      },
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

  it('rejects member-style calls, positions outside calls, and ambiguous multiline contexts', () => {
    expect(call('float4 c = surface.Lighting(', 28)).toBeNull();
    expect(call('float4 c = Lighting', 19)).toBeNull();
    expect(callContextAt('Lighting(\n  normalWS', { line: 1, character: 10 })).toBeNull();
  });

  it('rejects function declarations', () => {
    expect(callContextAt(
      'float4 Lighting(float3 n, half r) { return 1; }',
      { line: 0, character: 30 },
    )).toBeNull();
  });

  it('accepts calls after return keywords', () => {
    expect(callContextAt(
      'float4 main() { return Lighting(',
      { line: 0, character: 32 },
    )).toMatchObject({
      calleeName: 'Lighting',
      activeParameter: 0,
    });
  });

  it('combines with suggestion context to reject comments and strings', () => {
    const comment = '// Lighting(';
    const commentPosition = { line: 0, character: comment.length };
    expect(suggestionContextAt(comment, commentPosition, 'hlsl', 'file:///t/test.hlsl').kind).toBe('comment');

    const string = 'float4 c = "Lighting(";';
    const stringPosition = { line: 0, character: 21 };
    expect(suggestionContextAt(string, stringPosition, 'hlsl', 'file:///t/test.hlsl').kind).toBe('string');
  });
});
