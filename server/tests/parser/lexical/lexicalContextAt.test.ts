import { describe, it, expect } from 'vitest';
import { lexicalContextAt } from '../../../src/parser/lexical/cursor';

describe('lexicalContextAt — preserved behavior', () => {
  it('classifies a cursor inside a // line comment as comment', () => {
    const text = 'float a = 1; // note';
    expect(lexicalContextAt(text, { line: 0, character: 'float a = 1; // no'.length })).toBe('comment');
  });

  it('classifies a cursor inside a multi-line block comment as comment', () => {
    const text = '/*\n block helper\n*/';
    expect(lexicalContextAt(text, { line: 1, character: 4 })).toBe('comment');
  });

  it('classifies a cursor inside a string as string', () => {
    const text = 'float4 main() { return "he';
    expect(lexicalContextAt(text, { line: 0, character: 'float4 main() { return "he'.length })).toBe('string');
  });

  it('classifies a cursor on an opening quote as string', () => {
    const text = 'x = "abc"';
    expect(lexicalContextAt(text, { line: 0, character: 4 })).toBe('string'); // the opening "
  });

  it('treats // inside a string as string, not comment', () => {
    const text = 'x = "a//b"';
    expect(lexicalContextAt(text, { line: 0, character: 7 })).toBe('string'); // inside "a//b"
  });

  it('returns code for a plain identifier position', () => {
    const text = 'float value;';
    expect(lexicalContextAt(text, { line: 0, character: 8 })).toBe('code');
  });
});

describe('lexicalContextAt — out-of-range and boundary parity', () => {
  it('returns comment past EOL when a // ran to end of line (Class B parity)', () => {
    const text = 'a // b';
    expect(lexicalContextAt(text, { line: 0, character: 20 })).toBe('comment');
  });

  it('returns code past EOL on a plain line', () => {
    const text = 'abc';
    expect(lexicalContextAt(text, { line: 0, character: 20 })).toBe('code');
  });

  it('returns code for an out-of-range line or negative position', () => {
    expect(lexicalContextAt('abc', { line: 5, character: 0 })).toBe('code');
    expect(lexicalContextAt('abc', { line: -1, character: 0 })).toBe('code');
    expect(lexicalContextAt('abc', { line: 0, character: -1 })).toBe('code');
  });
});

describe('lexicalContextAt — on-delimiter refinement', () => {
  it('classifies a cursor exactly on a comment delimiter as comment', () => {
    // A cursor sitting on the comment slashes is now part of the comment
    // (degenerate refinement: old returned 'code' here). Realistically reachable
    // only with the caret on the first slash of an identifier-glued `x//` — where
    // suppressing code actions on a comment marker is the more correct outcome.
    const text = 'a // b';
    expect(lexicalContextAt(text, { line: 0, character: 2 })).toBe('comment'); // first / of //
    const block = 'a /* b */ c';
    expect(lexicalContextAt(block, { line: 0, character: 2 })).toBe('comment'); // / of /*
  });
});
