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

  it('preserves string contents but masks braces inside strings', () => {
    // Strings stay readable so regexes like /Shader\s+"([^"]*)"/ still work.
    const out = sanitizeLine('Shader "Test/X" { Pass { } }');
    expect(out.includes('Test/X')).toBe(true);
    expect((out.match(/"/g) ?? []).length).toBe(2);
    // But structural `}` inside a string is masked so brace counters
    // don't drop depth on a `"}"` literal.
    const tricky = sanitizeLine('const s = "}";');
    expect(tricky.includes('}')).toBe(false);
    expect(tricky.includes('s = "')).toBe(true);
  });

  it('does not carry block-comment state across lines (MVP limitation)', () => {
    const out = sanitizeLine('/* unterminated');
    expect(out).toBe(' '.repeat(out.length));
    const next = sanitizeLine('still code */');
    expect(next.includes('still code')).toBe(true);
  });

  it('handles escaped quotes inside strings without ending the string early', () => {
    // \" inside a string is kept verbatim so the parser can still see the
    // outer quote pair boundaries.
    const out = sanitizeLine('Shader "a\\"b" { }');
    expect(out).toHaveLength('Shader "a\\"b" { }'.length);
    // String content visible (escape kept literal).
    expect(out.includes('a\\"b')).toBe(true);
    // Outer braces preserved (we're outside the string when we hit them).
    expect(out.includes('{')).toBe(true);
    expect(out.includes('}')).toBe(true);
  });

  it('masks braces inside strings even with surrounding code', () => {
    const out = sanitizeLine('Pass { Name "left{right}end" }');
    expect(out.includes('left right end')).toBe(true); // braces became spaces
    // The outer Pass `{` and final `}` survive.
    expect((out.match(/\{/g) ?? []).length).toBe(1);
    expect((out.match(/\}/g) ?? []).length).toBe(1);
  });
});
