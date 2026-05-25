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

  it('returns the identifier immediately before the cursor at a call boundary', () => {
    const text = 'half4 color = CharFragmentPBR(inputData);';
    const result = wordAt(text, { line: 0, character: text.indexOf('(') });

    expect(result?.text).toBe('CharFragmentPBR');
    expect(result?.range.start.character).toBe(14);
    expect(result?.range.end.character).toBe(29);
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

  it('returns an array element receiver for member access', () => {
    const result = memberAccessAt('float3 c = lights[i].color;', { line: 0, character: 22 });

    expect(result?.member.text).toBe('color');
    expect(result?.receiver?.text).toBe('lights[i]');
    expect(result?.receiver?.range).toEqual({
      start: { line: 0, character: 11 },
      end: { line: 0, character: 20 },
    });
  });

  it('returns a nested field receiver for member access', () => {
    const text = 'float r = surface.brdfData.roughness;';
    const result = memberAccessAt(text, { line: 0, character: text.indexOf('roughness') + 3 });

    expect(result?.member.text).toBe('roughness');
    expect(result?.receiver?.text).toBe('surface.brdfData');
    expect(result?.receiver?.range).toEqual({
      start: { line: 0, character: 10 },
      end: { line: 0, character: 26 },
    });
  });

  it('keeps direct cbuffer struct receivers unchanged', () => {
    const result = memberAccessAt('float v = settings.value;', { line: 0, character: 20 });

    expect(result?.member.text).toBe('value');
    expect(result?.receiver?.text).toBe('settings');
  });
});
