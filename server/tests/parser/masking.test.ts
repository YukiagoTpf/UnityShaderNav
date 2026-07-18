import { describe, it, expect } from 'vitest';
import {
  maskCommentScan,
  maskCommentsLine,
  scanCommentRoles,
} from '../../src/parser/masking';

describe('maskCommentsLine — preserve mode (comments only)', () => {
  it('does not enter block-comment mode when /* is inside a string literal', () => {
    const result = maskCommentsLine('#define S "/*"', false);
    expect(result.inBlockComment).toBe(false);
    expect(result.code).toBe('#define S "/*"');
  });

  it('does not treat // inside a string literal as a line comment', () => {
    const result = maskCommentsLine('#define S "//" trailing', false);
    expect(result.inBlockComment).toBe(false);
    expect(result.code).toBe('#define S "//" trailing');
  });

  it('closes the string on an escaped quote so a later /* is a real block opener', () => {
    const result = maskCommentsLine('#define S "a\\"b" /* tail', false);
    expect(result.inBlockComment).toBe(true);
    expect(result.code).toBe('#define S "a\\"b"        ');
  });

  it('strips a normal block comment on a single line, preserving columns', () => {
    const result = maskCommentsLine('int x = 1; /* c */ int y;', false);
    expect(result.inBlockComment).toBe(false);
    expect(result.code).toBe('int x = 1;         int y;');
  });

  it('strips a block comment that spans two lines across two calls', () => {
    const first = maskCommentsLine('before /* block', false);
    expect(first.inBlockComment).toBe(true);
    expect(first.code).toBe('before         ');

    const second = maskCommentsLine('still */ after', first.inBlockComment);
    expect(second.inBlockComment).toBe(false);
    expect(second.code).toBe('         after');
  });

  it('does not toggle string mode for a " inside a block comment', () => {
    const first = maskCommentsLine('start /*', false);
    expect(first.inBlockComment).toBe(true);

    const second = maskCommentsLine('inside " still */ code // tail', first.inBlockComment);
    expect(second.inBlockComment).toBe(false);
    expect(second.code).toBe('                  code        ');
  });

  it('keeps a single trailing slash and an empty line intact', () => {
    expect(maskCommentsLine('a / b', false).code).toBe('a / b');
    expect(maskCommentsLine('', false)).toEqual({ code: '', inBlockComment: false });
  });
});

describe('maskCommentsLine — property vs token quote handling', () => {
  const line = '_Name ("Base Map", 2D)';

  it("'preserve' keeps the string body (token scanner needs the content)", () => {
    expect(maskCommentsLine(line, false, { strings: 'preserve' }).code).toBe('_Name ("Base Map", 2D)');
  });

  it("'blank-body' blanks the body but keeps both quotes (property scanner)", () => {
    // Body blanked to spaces, both delimiters preserved, columns unchanged.
    expect(maskCommentsLine(line, false, { strings: 'blank-body' }).code).toBe('_Name ("        ", 2D)');
  });

  it("'blank-body' suppresses a Properties keyword hidden in a string", () => {
    const masked = maskCommentsLine('Shader "Test/Properties"', false, { strings: 'blank-body' }).code;
    expect(/\bProperties\b/.test(masked)).toBe(false);
    expect(masked).toBe(`Shader "${' '.repeat('Test/Properties'.length)}"`);
  });

  it("'blank-body' blanks an escaped quote and its body, keeping the outer quotes", () => {
    expect(maskCommentsLine('"a\\"b"', false, { strings: 'blank-body' }).code).toBe('"    "');
  });

  it("'blank-braces' preserves names but masks only braces inside strings", () => {
    const line = 'Pass { Name "left{right}end" }';
    const result = maskCommentsLine(line, false, { strings: 'blank-braces' });

    expect(result.code).toBe('Pass { Name "left right end" }');
    expect(result.code).toHaveLength(line.length);
    expect(result.inBlockComment).toBe(false);
  });

  it('projects all-string masking from one existing comment scan', () => {
    const line = 'Tags { "Key" = "Value" } // tail';
    const scan = scanCommentRoles(line, false);

    expect(maskCommentScan(line, scan, { strings: 'blank-all' })).toBe(
      'Tags {       =         }        ',
    );
  });
});

describe('scanCommentRoles — per-column roles and EOL state', () => {
  it('marks code, string quotes/body, and comments distinctly', () => {
    const { roles } = scanCommentRoles('x "ab" // c', false);
    expect(roles[0]).toBe('code'); // x
    expect(roles[2]).toBe('stringQuote'); // opening "
    expect(roles[3]).toBe('stringBody'); // a
    expect(roles[5]).toBe('stringQuote'); // closing "
    expect(roles[7]).toBe('comment'); // first / of //
  });

  it('reports lineComment and a comment EOL slot after //', () => {
    const scan = scanCommentRoles('code // tail', false);
    expect(scan.lineComment).toBe(true);
    expect(scan.roles[scan.roles.length - 1]).toBe('comment');
  });

  it('reports an unterminated string at the EOL slot', () => {
    const scan = scanCommentRoles('x = "open', false);
    expect(scan.inString).toBe(true);
    expect(scan.roles[scan.roles.length - 1]).toBe('stringBody');
  });

  it('threads an open block comment to the EOL slot and next line', () => {
    const scan = scanCommentRoles('start /* block', false);
    expect(scan.inBlockComment).toBe(true);
    expect(scan.roles[scan.roles.length - 1]).toBe('comment');
  });
});
