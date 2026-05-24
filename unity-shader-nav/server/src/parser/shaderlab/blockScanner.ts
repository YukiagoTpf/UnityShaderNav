import type { BlockKind, ScanResult, ShaderLabBlock } from '@unity-shader-nav/shared';

const START_DIRECTIVES: Record<string, BlockKind> = {
  HLSLPROGRAM: 'HLSLPROGRAM',
  CGPROGRAM: 'CGPROGRAM',
  HLSLINCLUDE: 'HLSLINCLUDE',
  CGINCLUDE: 'CGINCLUDE',
};

const END_DIRECTIVES_FOR: Record<BlockKind, string> = {
  HLSLPROGRAM: 'ENDHLSL',
  CGPROGRAM: 'ENDCG',
  HLSLINCLUDE: 'ENDHLSL',
  CGINCLUDE: 'ENDCG',
};

function stripDirectiveComments(line: string, inBlockComment: boolean): { code: string; inBlockComment: boolean } {
  const chars = line.split('');
  let inString = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (inBlockComment) {
      chars[i] = ' ';
      if (ch === '*' && next === '/') {
        chars[i + 1] = ' ';
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (inString) {
      if (ch === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      for (let j = i; j < chars.length; j++) chars[j] = ' ';
      break;
    }

    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i++;
      inBlockComment = true;
      continue;
    }

    if (ch === '"') {
      inString = true;
    }
  }

  return { code: chars.join(''), inBlockComment };
}

function trimDirective(line: string, inBlockComment: boolean): { directive: string; inBlockComment: boolean } {
  const stripped = stripDirectiveComments(line, inBlockComment);
  return {
    directive: stripped.code.trim(),
    inBlockComment: stripped.inBlockComment,
  };
}

export function scanBlocks(text: string): ScanResult {
  const lines = text.split(/\r?\n/);
  const blocks: ShaderLabBlock[] = [];

  let i = 0;
  let inBlockComment = false;
  while (i < lines.length) {
    const start = trimDirective(lines[i], inBlockComment);
    inBlockComment = start.inBlockComment;
    const startKind = START_DIRECTIVES[start.directive];
    if (!startKind) { i++; continue; }

    const startLine = i;
    const endDirective = END_DIRECTIVES_FOR[startKind];
    let endLine = -1;
    let j = i + 1;
    let innerInBlockComment = inBlockComment;
    for (; j < lines.length; j++) {
      const end = trimDirective(lines[j], innerInBlockComment);
      innerInBlockComment = end.inBlockComment;
      if (end.directive === endDirective) {
        endLine = j;
        break;
      }
    }

    if (endLine === -1) {
      blocks.push({
        kind: startKind,
        startLine,
        endLine: lines.length - 1,
        contentStartLine: startLine + 1,
        contentEndLine: lines.length - 1,
        unterminated: true,
      });
      i = lines.length;
    } else {
      inBlockComment = innerInBlockComment;
      blocks.push({
        kind: startKind,
        startLine,
        endLine,
        contentStartLine: startLine + 1,
        contentEndLine: endLine - 1,
        unterminated: false,
      });
      i = endLine + 1;
    }
  }

  return { blocks };
}
