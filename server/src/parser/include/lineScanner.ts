import type { Range } from '@unity-shader-nav/shared';
import { exactSource, type ExactSource } from '../../sourceLocation';
import { maskCommentsLine } from '../masking';

export interface IncludeDirective {
  path: string;
  /** Range from `#` through the include directive name. */
  directiveRange: Range;
  /** Range of the path string inside its quotes or angle brackets. */
  pathRange: Range;
  line: number;
}

const INCLUDE_RE = /^(\s*)(#\s*include(?:_with_pragmas)?)\s+(?:"([^"\n]+)"|<([^>\n]+)>)/i;

/** Parse one comment-masked source line without changing its column offsets. */
export function scanIncludeLine(code: string, line: number): IncludeDirective | null {
  const match = INCLUDE_RE.exec(code);
  if (!match) return null;

  const directive = match[2];
  const path = match[3] ?? match[4];
  const directiveStart = match[1].length;
  const pathStart = match[0].lastIndexOf(path);
  return {
    path,
    line,
    directiveRange: {
      start: { line, character: directiveStart },
      end: { line, character: directiveStart + directive.length },
    },
    pathRange: {
      start: { line, character: pathStart },
      end: { line, character: pathStart + path.length },
    },
  };
}

export function scanIncludes(text: string | ExactSource): IncludeDirective[] {
  const source = exactSource(
    typeof text === 'string' ? text : text.sourceText,
    typeof text === 'string' ? undefined : text,
  );
  const lines = source.sourceLines;
  const directives: IncludeDirective[] = [];
  let inBlockComment = false;

  for (let line = 0; line < lines.length; line++) {
    const stripped = maskCommentsLine(lines[line], inBlockComment, { strings: 'preserve' });
    const code = stripped.code;
    inBlockComment = stripped.inBlockComment;

    const directive = scanIncludeLine(code, line);
    if (directive) directives.push(directive);
  }

  return directives;
}
