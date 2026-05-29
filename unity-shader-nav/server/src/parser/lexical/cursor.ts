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

export type SuggestionContextKind =
  | 'hlslCode'
  | 'shaderLabCode'
  | 'semanticPosition'
  | 'shaderLabStateValue'
  | 'comment'
  | 'string';

export interface CompletionPrefix {
  text: string;
  range: Range;
}

export interface CursorMember {
  receiver: string;
  memberPrefix: CompletionPrefix;
}

export interface CursorContext {
  word: WordAt | null;
  member: MemberAccess | null;
  lexical: LexicalContext;
  classification: SuggestionContextKind;
  prefix: CompletionPrefix;
  memberPrefix?: CursorMember;
}

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

export function emptyPrefix(line: number, character: number): CompletionPrefix {
  return {
    text: '',
    range: {
      start: { line, character },
      end: { line, character },
    },
  };
}

export function prefixAtLine(lineText: string, pos: Position): CompletionPrefix {
  const character = Math.max(0, Math.min(pos.character, lineText.length));
  let start = character;
  while (start > 0 && ID_CHAR_RE.test(lineText[start - 1])) start--;
  const text = lineText.slice(start, character);
  if (text.length > 0 && !ID_START_RE.test(text[0])) {
    return emptyPrefix(pos.line, character);
  }
  return {
    text,
    range: {
      start: { line: pos.line, character: start },
      end: { line: pos.line, character },
    },
  };
}

export function memberContextAt(lineText: string, prefix: CompletionPrefix): CursorMember | undefined {
  const dot = prefix.range.start.character - 1;
  if (dot < 0 || lineText[dot] !== '.') return undefined;
  const receiverStart = receiverExpressionStart(lineText, dot);
  if (receiverStart === dot) return undefined;
  const receiver = lineText.slice(receiverStart, dot);
  if (!ID_START_RE.test(receiver[0] ?? '')) return undefined;
  return {
    receiver,
    memberPrefix: prefix,
  };
}

export function isSemanticPosition(lineText: string, prefix: CompletionPrefix): boolean {
  const beforePrefix = lineText.slice(0, prefix.range.start.character).trimEnd();
  if (!beforePrefix.endsWith(':')) return false;

  const beforeColon = beforePrefix.slice(0, -1).trimEnd();
  const boundary = Math.max(
    beforeColon.lastIndexOf(';'),
    beforeColon.lastIndexOf('{'),
    beforeColon.lastIndexOf('}'),
    beforeColon.lastIndexOf(','),
  );
  const segment = beforeColon.slice(boundary + 1).trim();
  if (segment.includes('?')) return false;

  if (/^[A-Za-z_][A-Za-z0-9_<>,\s*&]*\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]*\])?$/.test(segment)) {
    return true;
  }

  return /^[A-Za-z_][A-Za-z0-9_<>,\s*&]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)$/.test(segment);
}

export const SHADERLAB_STATE_VALUE_CONTEXTS = new Set([
  'Blend',
  'BlendOp',
  'Cull',
  'ZWrite',
  'ZTest',
  'Offset',
  'ColorMask',
  'AlphaToMask',
  'Lighting',
  'Fog',
  'Conservative',
]);

export function isShaderLabStateValuePosition(lineText: string, prefix: CompletionPrefix): boolean {
  const beforePrefix = lineText.slice(0, prefix.range.start.character).trimEnd();
  const match = /\b([A-Za-z][A-Za-z0-9_]*)$/.exec(beforePrefix);
  return match ? SHADERLAB_STATE_VALUE_CONTEXTS.has(match[1]) : false;
}

export interface CursorClassification {
  classification: SuggestionContextKind;
  lexical: LexicalContext;
  prefix: CompletionPrefix;
  member: CursorMember | undefined;
}

export function classifyCursor(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): CursorClassification {
  const lines = text.split(/\r?\n/);
  const lineText = lines[pos.line] ?? '';
  const prefix = prefixAtLine(lineText, pos);
  const lexical = lexicalContextAt(text, pos);
  if (lexical !== 'code') {
    return { classification: lexical, lexical, prefix, member: undefined };
  }

  const baseKind: SuggestionContextKind = isShaderLabDocument(languageId, uri)
    && !isInsideShaderLabHlslBlock(text, pos)
    ? 'shaderLabCode'
    : 'hlslCode';
  const classification: SuggestionContextKind = baseKind === 'hlslCode' && isSemanticPosition(lineText, prefix)
    ? 'semanticPosition'
    : baseKind === 'shaderLabCode' && isShaderLabStateValuePosition(lineText, prefix)
      ? 'shaderLabStateValue'
      : baseKind;

  return {
    classification,
    lexical,
    prefix,
    member: memberContextAt(lineText, prefix),
  };
}

export function analyzeCursor(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): CursorContext {
  const c = classifyCursor(text, pos, languageId, uri);
  return {
    word: wordAt(text, pos),
    member: memberAccessAt(text, pos),
    lexical: c.lexical,
    classification: c.classification,
    prefix: c.prefix,
    memberPrefix: c.member,
  };
}
