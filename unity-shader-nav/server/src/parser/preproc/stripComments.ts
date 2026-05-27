export function stripComments(
  lineText: string,
  inBlockComment: boolean,
): { code: string; inBlockComment: boolean } {
  const chars = lineText.split('');

  for (let i = 0; i < chars.length; i++) {
    if (inBlockComment) {
      const endsBlock = chars[i] === '*' && chars[i + 1] === '/';
      chars[i] = ' ';

      if (endsBlock) {
        chars[i + 1] = ' ';
        i++;
        inBlockComment = false;
      }
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
