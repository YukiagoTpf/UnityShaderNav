import type { Position, Range } from '@unity-shader-nav/shared';
import { scanBlocks } from '../parser/shaderlab/blockScanner';

const ID_CHAR_RE = /[A-Za-z0-9_]/;
const ID_START_RE = /[A-Za-z_]/;

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

export interface SuggestionContext {
  kind: SuggestionContextKind;
  prefix: CompletionPrefix;
  member?: {
    receiver: string;
    memberPrefix: CompletionPrefix;
  };
}

type LexicalContext = 'code' | 'comment' | 'string';

function isShaderLabDocument(languageId: string | undefined, uri: string): boolean {
  return languageId === 'shaderlab' || /\.shader(?:$|[?#])/i.test(uri);
}

function isInsideShaderLabHlslBlock(text: string, pos: Position): boolean {
  return scanBlocks(text).blocks.some((block) =>
    pos.line >= block.contentStartLine && pos.line <= block.contentEndLine,
  );
}

function lexicalContextAt(text: string, pos: Position): LexicalContext {
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

function emptyPrefix(line: number, character: number): CompletionPrefix {
  return {
    text: '',
    range: {
      start: { line, character },
      end: { line, character },
    },
  };
}

function prefixAtLine(lineText: string, pos: Position): CompletionPrefix {
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

function receiverExpressionStart(line: string, end: number): number {
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

    if (squareDepth > 0 || parenDepth > 0 || braceDepth > 0) {
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

function memberContextAt(lineText: string, prefix: CompletionPrefix): SuggestionContext['member'] | undefined {
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

function isSemanticPosition(lineText: string, prefix: CompletionPrefix): boolean {
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

const SHADERLAB_STATE_VALUE_CONTEXTS = new Set(['Blend', 'Cull', 'ZWrite', 'ZTest', 'Offset', 'ColorMask']);

function isShaderLabStateValuePosition(lineText: string, prefix: CompletionPrefix): boolean {
  const beforePrefix = lineText.slice(0, prefix.range.start.character).trimEnd();
  const match = /\b([A-Za-z][A-Za-z0-9_]*)$/.exec(beforePrefix);
  return match ? SHADERLAB_STATE_VALUE_CONTEXTS.has(match[1]) : false;
}

export function suggestionContextAt(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): SuggestionContext {
  const lines = text.split(/\r?\n/);
  const lineText = lines[pos.line] ?? '';
  const prefix = prefixAtLine(lineText, pos);
  const lexical = lexicalContextAt(text, pos);
  if (lexical !== 'code') return { kind: lexical, prefix };

  const baseKind: SuggestionContextKind = isShaderLabDocument(languageId, uri)
    && !isInsideShaderLabHlslBlock(text, pos)
    ? 'shaderLabCode'
    : 'hlslCode';
  const kind: SuggestionContextKind = baseKind === 'hlslCode' && isSemanticPosition(lineText, prefix)
    ? 'semanticPosition'
    : baseKind === 'shaderLabCode' && isShaderLabStateValuePosition(lineText, prefix)
      ? 'shaderLabStateValue'
      : baseKind;

  return {
    kind,
    prefix,
    member: memberContextAt(lineText, prefix),
  };
}
