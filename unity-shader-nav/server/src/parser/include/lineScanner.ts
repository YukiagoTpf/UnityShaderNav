import type { Range } from '@unity-shader-nav/shared';

export interface IncludeDirective {
  path: string;
  /** Range of the path string inside the quotes. */
  pathRange: Range;
  line: number;
}

const INCLUDE_RE = /^\s*#\s*include\s*"([^"\n]+)"/;

function stripComments(lineText: string, inBlockComment: boolean): { code: string; inBlockComment: boolean } {
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

export function scanIncludes(text: string): IncludeDirective[] {
  const lines = text.split(/\r?\n/);
  const directives: IncludeDirective[] = [];
  let inBlockComment = false;

  for (let line = 0; line < lines.length; line++) {
    const stripped = stripComments(lines[line], inBlockComment);
    const code = stripped.code;
    inBlockComment = stripped.inBlockComment;

    const match = INCLUDE_RE.exec(code);
    if (!match) continue;

    const path = match[1];
    const pathStart = code.indexOf('"') + 1;
    const pathEnd = pathStart + path.length;
    directives.push({
      path,
      line,
      pathRange: {
        start: { line, character: pathStart },
        end: { line, character: pathEnd },
      },
    });
  }

  return directives;
}
