/**
 * The single comment/string state machine for the parser. Every scanner that
 * needs to know "what here is code vs. line/block comment vs. string" projects
 * from {@link scanCommentRoles} — replacing the copies that used to live in the
 * preproc, include, shaderlab, macros and lexical scanners.
 */

export type CommentRole = 'code' | 'comment' | 'stringQuote' | 'stringBody';

export interface CommentScan {
  /**
   * Per-column role, length `line.length + 1`. Index `[line.length]` carries the
   * end-of-line state (so a position at EOL can be classified): `'comment'` when
   * the line ends inside a block comment or after a `//`, `'stringBody'` when an
   * unterminated string is open, otherwise `'code'`.
   */
  roles: CommentRole[];
  /** Block-comment state carried to the next line. */
  inBlockComment: boolean;
  /** A string literal is still open at end of line (strings do not span lines). */
  inString: boolean;
  /** A `//` line comment was seen in code state on this line. */
  lineComment: boolean;
}

/**
 * Classify every column of one line given the incoming block-comment state.
 * String literals are tracked (backslash escapes honored); `//` makes the rest
 * of the line a comment; block comments span lines via the returned
 * `inBlockComment`.
 */
export function scanCommentRoles(line: string, inBlockComment: boolean): CommentScan {
  const len = line.length;
  const roles: CommentRole[] = new Array(len + 1);
  let inString = false;
  let lineComment = false;

  let i = 0;
  while (i < len) {
    const ch = line[i];
    const next = i + 1 < len ? line[i + 1] : undefined;

    if (inBlockComment) {
      roles[i] = 'comment';
      if (ch === '*' && next === '/') {
        roles[i + 1] = 'comment';
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }

    if (inString) {
      if (ch === '\\' && next !== undefined) {
        roles[i] = 'stringBody';
        roles[i + 1] = 'stringBody';
        i += 2;
        continue;
      }
      if (ch === '"') {
        roles[i] = 'stringQuote';
        inString = false;
        i += 1;
        continue;
      }
      roles[i] = 'stringBody';
      i += 1;
      continue;
    }

    // Code state.
    if (ch === '/' && next === '/') {
      for (let j = i; j < len; j++) roles[j] = 'comment';
      roles[len] = 'comment';
      lineComment = true;
      return { roles, inBlockComment, inString, lineComment };
    }

    if (ch === '/' && next === '*') {
      roles[i] = 'comment';
      roles[i + 1] = 'comment';
      i += 2;
      inBlockComment = true;
      continue;
    }

    if (ch === '"') {
      roles[i] = 'stringQuote';
      inString = true;
      i += 1;
      continue;
    }

    roles[i] = 'code';
    i += 1;
  }

  roles[len] = inBlockComment ? 'comment' : inString ? 'stringBody' : 'code';
  return { roles, inBlockComment, inString, lineComment };
}

/**
 * How string literals are treated when masking:
 * - `'preserve'`: leave the string body untouched (only comments are blanked).
 * - `'blank-body'`: blank the body to spaces but keep both quotes, so a literal
 *   can never contribute keywords/braces to downstream scanning while regexes
 *   anchored on `"..."` still see the delimiters.
 * - `'blank-braces'`: preserve readable string content but blank `{` and `}` so
 *   structure scanners can capture names without counting braces in literals.
 */
export type StringHandling = 'preserve' | 'blank-body' | 'blank-braces';

export interface MaskLineResult {
  code: string;
  inBlockComment: boolean;
}

/** Project one already-classified line without rerunning the lexical state machine. */
export function maskCommentScan(
  line: string,
  scan: CommentScan,
  options: { strings?: StringHandling | 'blank-all' } = {},
): string {
  const { strings = 'preserve' } = options;
  const chars = line.split('');
  for (let i = 0; i < chars.length; i++) {
    const role = scan.roles[i];
    if (role === 'comment') {
      chars[i] = ' ';
    } else if (
      (strings === 'blank-all' && (role === 'stringQuote' || role === 'stringBody'))
      || (
        role === 'stringBody'
        && (
          strings === 'blank-body'
          || (strings === 'blank-braces' && (chars[i] === '{' || chars[i] === '}'))
        )
      )
    ) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

/**
 * Replace comment runs and the selected string content with spaces while
 * preserving every other byte and the original column widths. Threads the
 * block-comment state through the returned `inBlockComment`.
 */
export function maskCommentsLine(
  line: string,
  inBlockComment: boolean,
  options: { strings?: StringHandling } = {},
): MaskLineResult {
  const scan = scanCommentRoles(line, inBlockComment);
  return {
    code: maskCommentScan(line, scan, options),
    inBlockComment: scan.inBlockComment,
  };
}
