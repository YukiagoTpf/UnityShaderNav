export function stripComments(
  lineText: string,
  inBlockComment: boolean,
): { code: string; inBlockComment: boolean } {
  const chars = lineText.split('');
  // String state is scoped to a single line — preprocessor source does not
  // meaningfully carry string literals across line boundaries, so we do not
  // thread `inString` through the return value.
  let inString = false;

  for (let i = 0; i < chars.length; i++) {
    if (inBlockComment) {
      // A `"` inside a block comment must NOT toggle string mode, otherwise
      // the closing `*/` could be missed.
      const endsBlock = chars[i] === '*' && chars[i + 1] === '/';
      chars[i] = ' ';

      if (endsBlock) {
        chars[i + 1] = ' ';
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (inString) {
      // Backslash escapes the next character (including an embedded quote).
      if (chars[i] === '\\' && i + 1 < chars.length) {
        i++;
        continue;
      }
      if (chars[i] === '"') {
        inString = false;
      }
      continue;
    }

    if (chars[i] === '"') {
      inString = true;
      continue;
    }

    if (chars[i] === '/' && chars[i + 1] === '/') {
      for (let j = i; j < chars.length; j++) chars[j] = ' ';
      break;
    }

    if (chars[i] === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i++;
      inBlockComment = true;
    }
  }

  return { code: chars.join(''), inBlockComment };
}
