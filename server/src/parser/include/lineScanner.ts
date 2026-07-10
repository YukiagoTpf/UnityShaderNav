import type { Range } from '@unity-shader-nav/shared';
import { maskCommentsLine } from '../masking';

export interface IncludeDirective {
  path: string;
  /** Range of the path string inside the quotes. */
  pathRange: Range;
  line: number;
}

const INCLUDE_RE = /^\s*#\s*include\s*"([^"\n]+)"/;

export function scanIncludes(text: string): IncludeDirective[] {
  const lines = text.split(/\r?\n/);
  const directives: IncludeDirective[] = [];
  let inBlockComment = false;

  for (let line = 0; line < lines.length; line++) {
    const stripped = maskCommentsLine(lines[line], inBlockComment, { strings: 'preserve' });
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
