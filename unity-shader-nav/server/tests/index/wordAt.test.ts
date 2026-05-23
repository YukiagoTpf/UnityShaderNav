import { describe, it, expect } from 'vitest';
import { memberAccessAt, wordAt } from '../../src/index/wordAt';

describe('wordAt', () => {
  it('returns the identifier under cursor', () => {
    const text = 'float4 _MainTex = float4(0,0,0,1);';
    const result = wordAt(text, { line: 0, character: 9 });
    expect(result?.text).toBe('_MainTex');
    expect(result?.range.start.character).toBe(7);
    expect(result?.range.end.character).toBe(15);
  });

  it('returns null when cursor is on whitespace or symbol', () => {
    expect(wordAt('a + b', { line: 0, character: 1 })).toBeNull();
  });

  it('supports identifiers with leading underscore and digits', () => {
    expect(wordAt('  _Color2', { line: 0, character: 4 })?.text).toBe('_Color2');
  });
});

describe('memberAccessAt', () => {
  it('returns member and receiver for member access', () => {
    const result = memberAccessAt('  float x = surface.uv;', { line: 0, character: 20 });

    expect(result?.member.text).toBe('uv');
    expect(result?.member.range.start.character).toBe(20);
    expect(result?.receiver?.text).toBe('surface');
    expect(result?.receiver?.range.start.character).toBe(12);
  });

  it('returns just the word when there is no receiver', () => {
    const result = memberAccessAt('void foo() { bar; }', { line: 0, character: 14 });

    expect(result?.member.text).toBe('bar');
    expect(result?.receiver).toBeNull();
  });
});
