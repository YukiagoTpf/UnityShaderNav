import { describe, it, expect } from 'vitest';
import { sanitizeLine } from '../../../src/parser/shaderlab/sanitize';

describe('sanitizeLine', () => {
  it('passes through plain code unchanged', () => {
    expect(sanitizeLine('Pass {')).toBe('Pass {');
  });

  it('masks // line comments to spaces', () => {
    const input = 'Pass { // HLSLPROGRAM here';
    const out = sanitizeLine(input);
    expect(out).toHaveLength(input.length);
    expect(out.slice(0, 7)).toBe('Pass { ');
    expect(out.slice(7)).toBe(' '.repeat('// HLSLPROGRAM here'.length));
  });

  it('masks /* */ same-line block comments', () => {
    const input = 'HLSLPROGRAM /* trailing */';
    const out = sanitizeLine(input);
    expect(out).toHaveLength(input.length);
    expect(out.slice(0, 11)).toBe('HLSLPROGRAM');
    expect(out.slice(11).trim()).toBe('');
  });

  it('handles multiple block comments on one line', () => {
    const out = sanitizeLine('Pass /*a*/ { /*b*/ }');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('Pass { }');
  });

  it('masks string contents but preserves quote characters', () => {
    const out = sanitizeLine('Shader "Test/X" { Pass { } }');
    expect(out.includes('Test/X')).toBe(false);
    expect((out.match(/"/g) ?? []).length).toBe(2);
    const tricky = sanitizeLine('const s = "}";');
    expect(tricky.includes('}')).toBe(false);
  });

  it('does not carry block-comment state across lines (MVP limitation)', () => {
    const out = sanitizeLine('/* unterminated');
    expect(out).toBe(' '.repeat(out.length));
    const next = sanitizeLine('still code */');
    expect(next.includes('still code')).toBe(true);
  });

  it('handles escaped quotes inside strings', () => {
    // Input: "a\"b" Pass — the quoted span contains an escaped quote and
    // must not prematurely end the string. After sanitization, the entire
    // content between the outer quotes is masked.
    const input = '"a\\"b" Pass';
    const out = sanitizeLine(input);
    expect(out).toHaveLength(input.length);
    expect(out.endsWith(' Pass')).toBe(true);
    // The character at index 1 (the 'a' inside the string) must be masked.
    expect(out[1]).toBe(' ');
    // The escaped backslash + quote at index 2-3 must be masked.
    expect(out.slice(2, 4)).toBe('  ');
    // The 'b' at index 4 must be masked.
    expect(out[4]).toBe(' ');
    // Outer quotes preserved.
    expect(out[0]).toBe('"');
    expect(out[5]).toBe('"');
  });
});
