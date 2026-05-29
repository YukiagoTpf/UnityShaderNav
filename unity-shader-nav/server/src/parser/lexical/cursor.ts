import type { Position, Range } from '@unity-shader-nav/shared';
import { scanBlocks } from '../shaderlab/blockScanner';

export const ID_CHAR_RE = /[A-Za-z0-9_]/;
export const ID_START_RE = /[A-Za-z_]/;

export interface WordAt {
  text: string;
  range: Range;
}

export interface MemberAccess {
  member: WordAt;
  receiver: WordAt | null;
}

export type LexicalContext = 'code' | 'comment' | 'string';

export function wordAt(text: string, pos: Position): WordAt | null {
  const lines = text.split(/\r?\n/);
  if (pos.line < 0 || pos.line >= lines.length) return null;

  const line = lines[pos.line];
  let ch = pos.character;
  if (ch < 0 || ch > line.length) return null;
  if (!ID_CHAR_RE.test(line[ch] ?? '')) {
    if (
      ch === 0
      || !ID_CHAR_RE.test(line[ch - 1] ?? '')
      || /\s/.test(line[ch] ?? ' ')
    ) {
      return null;
    }
    ch--;
  }

  let start = ch;
  while (start > 0 && ID_CHAR_RE.test(line[start - 1])) start--;

  let end = ch;
  while (end < line.length && ID_CHAR_RE.test(line[end])) end++;

  if (start === end) return null;

  const word = line.slice(start, end);
  if (!/^[A-Za-z_]/.test(word)) return null;

  return {
    text: word,
    range: {
      start: { line: pos.line, character: start },
      end: { line: pos.line, character: end },
    },
  };
}

export function memberAccessAt(text: string, pos: Position): MemberAccess | null {
  const member = wordAt(text, pos);
  if (!member) return null;

  const lines = text.split(/\r?\n/);
  const line = lines[pos.line];
  if (!line) return { member, receiver: null };

  let cursor = member.range.start.character - 1;
  if (cursor < 0 || line[cursor] !== '.') return { member, receiver: null };

  const end = cursor;
  const start = receiverExpressionStart(line, end);
  if (start === end) return { member, receiver: null };

  const textBeforeDot = line.slice(start, end);
  if (!ID_START_RE.test(textBeforeDot[0] ?? '')) return { member, receiver: null };

  return {
    member,
    receiver: {
      text: textBeforeDot,
      range: {
        start: { line: pos.line, character: start },
        end: { line: pos.line, character: end },
      },
    },
  };
}

export function receiverExpressionStart(line: string, end: number): number {
  let cursor = end - 1;
  let squareDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;

  while (cursor >= 0) {
    const ch = line[cursor];
    if (ch === ']') {
      squareDepth++;
      cursor--;
      continue;
    }
    if (ch === ')') {
      parenDepth++;
      cursor--;
      continue;
    }
    if (ch === '}') {
      braceDepth++;
      cursor--;
      continue;
    }
    if (ch === '[' && squareDepth > 0) {
      squareDepth--;
      cursor--;
      continue;
    }
    if (ch === '(' && parenDepth > 0) {
      parenDepth--;
      cursor--;
      continue;
    }
    if (ch === '{' && braceDepth > 0) {
      braceDepth--;
      cursor--;
      continue;
    }

    const insideBalancedGroup = squareDepth > 0 || parenDepth > 0 || braceDepth > 0;
    if (insideBalancedGroup) {
      cursor--;
      continue;
    }

    if (ID_CHAR_RE.test(ch) || ch === '.') {
      cursor--;
      continue;
    }

    break;
  }

  return cursor + 1;
}

export function lexicalContextAt(text: string, pos: Position): LexicalContext {
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;

  for (let line = 0; line <= pos.line && line < lines.length; line++) {
    const lineText = lines[line];
    let inString = false;
    const limit = line === pos.line ? Math.min(pos.character, lineText.length) : lineText.length;

    for (let character = 0; character <= limit; character++) {
      if (line === pos.line && character === pos.character) {
        if (inBlockComment) return 'comment';
        if (inString) return 'string';
        if (lineText[character] === '"') return 'string';
        return 'code';
      }

      const ch = lineText[character];
      const next = lineText[character + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          character++;
          inBlockComment = false;
        }
        continue;
      }

      if (inString) {
        if (ch === '\\' && next !== undefined) {
          character++;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }

      if (ch === '/' && next === '/') {
        if (line === pos.line) return 'comment';
        break;
      }

      if (ch === '/' && next === '*') {
        character++;
        inBlockComment = true;
        continue;
      }

      if (ch === '"') inString = true;
    }
  }

  return 'code';
}

export function isShaderLabDocument(languageId: string | undefined, uri: string): boolean {
  return languageId === 'shaderlab' || /\.shader(?:$|[?#])/i.test(uri);
}

export function isInsideShaderLabHlslBlock(text: string, pos: Position): boolean {
  return scanBlocks(text).blocks.some((block) =>
    pos.line >= block.contentStartLine && pos.line <= block.contentEndLine,
  );
}
