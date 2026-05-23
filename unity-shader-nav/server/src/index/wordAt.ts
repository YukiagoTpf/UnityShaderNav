import type { Position, Range } from '@unity-shader-nav/shared';

const ID_CHAR_RE = /[A-Za-z0-9_]/;

export interface WordAt {
  text: string;
  range: Range;
}

export interface MemberAccess {
  member: WordAt;
  receiver: WordAt | null;
}

export function wordAt(text: string, pos: Position): WordAt | null {
  const lines = text.split(/\r?\n/);
  if (pos.line < 0 || pos.line >= lines.length) return null;

  const line = lines[pos.line];
  const ch = pos.character;
  if (ch < 0 || ch > line.length) return null;
  if (!ID_CHAR_RE.test(line[ch] ?? '')) return null;

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

  cursor--;
  const end = cursor + 1;
  while (cursor >= 0 && ID_CHAR_RE.test(line[cursor])) cursor--;
  const start = cursor + 1;
  if (start === end) return { member, receiver: null };

  const textBeforeDot = line.slice(start, end);
  if (!/^[A-Za-z_]/.test(textBeforeDot)) return { member, receiver: null };

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
