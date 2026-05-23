import type { Range } from '@unity-shader-nav/shared';

export interface DefineDirective {
  name: string;
  line: number;
  nameRange: Range;
}

const DEFINE_RE = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/;

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

export function scanDefines(text: string): DefineDirective[] {
  const lines = text.split(/\r?\n/);
  const out: DefineDirective[] = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = stripComments(raw, inBlockComment);
    const code = stripped.code;
    inBlockComment = stripped.inBlockComment;
    const match = DEFINE_RE.exec(code);
    if (!match) continue;

    const name = match[1];
    const defineStart = code.indexOf('define');
    const nameStart = code.indexOf(name, defineStart + 'define'.length);
    out.push({
      name,
      line: i,
      nameRange: {
        start: { line: i, character: nameStart },
        end: { line: i, character: nameStart + name.length },
      },
    });
  }

  return out;
}
