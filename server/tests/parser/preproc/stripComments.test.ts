import { describe, it, expect } from 'vitest';
import { stripComments } from '../../../src/parser/preproc/stripComments';

describe('stripComments — string awareness', () => {
  it('does not enter block-comment mode when /* is inside a string literal', () => {
    const result = stripComments('#define S "/*"', false);
    expect(result.inBlockComment).toBe(false);
    // The string body must be preserved verbatim.
    expect(result.code).toBe('#define S "/*"');
  });

  it('does not treat // inside a string literal as a line comment', () => {
    const result = stripComments('#define S "//" trailing', false);
    expect(result.inBlockComment).toBe(false);
    // The `trailing` token must survive — the // inside the string is not a comment.
    expect(result.code).toBe('#define S "//" trailing');
  });

  it('handles escaped quotes inside a string without leaking state', () => {
    // After `"a\"b"` the string is closed, so a subsequent /* outside should
    // still be recognised as a real block-comment opener.
    const result = stripComments('#define S "a\\"b" /* tail', false);
    expect(result.inBlockComment).toBe(true);
    // The /* tail portion must be blanked out as a block comment.
    expect(result.code.startsWith('#define S "a\\"b" ')).toBe(true);
    expect(result.code).toBe('#define S "a\\"b"        ');
  });

  it('still strips a normal block comment on a single line', () => {
    const result = stripComments('int x = 1; /* c */ int y;', false);
    expect(result.inBlockComment).toBe(false);
    expect(result.code).toBe('int x = 1;         int y;');
  });

  it('strips a block comment that spans two lines across two calls', () => {
    const first = stripComments('before /* block', false);
    expect(first.inBlockComment).toBe(true);
    expect(first.code).toBe('before         ');

    const second = stripComments('still */ after', first.inBlockComment);
    expect(second.inBlockComment).toBe(false);
    expect(second.code).toBe('         after');
  });

  it('does not toggle string mode for a " inside a block comment', () => {
    // Open block on line 1, then a `"` appears inside the block on line 2,
    // and the block closes later on line 2. After the close we are back to
    // normal scanning, so a // afterwards is a real line comment.
    const first = stripComments('start /*', false);
    expect(first.inBlockComment).toBe(true);

    const second = stripComments('inside " still */ code // tail', first.inBlockComment);
    expect(second.inBlockComment).toBe(false);
    // Everything up to and including `*/` is blanked; `code` survives;
    // the `// tail` is a real line comment and gets blanked.
    expect(second.code).toBe('                  code        ');
  });
});
