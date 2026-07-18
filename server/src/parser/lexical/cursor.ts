import type { Position, Range } from '@unity-shader-nav/shared';
import { exactSource, type ExactSource } from '../../sourceLocation';
import { isShaderLabStateValueContext } from '../../vocabulary';
import { scanBlocksFromExactSource } from '../shaderlab/blockScanner';
import { scanCommentRoles } from '../masking';

const ID_CHAR_RE = /[A-Za-z0-9_]/;
const ID_START_RE = /[A-Za-z_]/;

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

export type CursorSource = ExactSource & {
  readonly blocks?: readonly import('@unity-shader-nav/shared').ShaderLabBlock[];
};

function toCursorSource(text: string | CursorSource): CursorSource {
  return exactSource(
    typeof text === 'string' ? text : text.sourceText,
    typeof text === 'string' ? undefined : text,
  ) as CursorSource;
}

function wordAt(source: CursorSource, pos: Position): WordAt | null {
  if (pos.line < 0 || pos.line >= source.sourceLines.length) return null;

  const line = source.sourceLines[pos.line];
  let ch = pos.character;
  if (ch < 0 || ch > line.length) return null;
  if (!ID_CHAR_RE.test(line[ch] ?? '')) {
    if (
      ch === 0
      || !ID_CHAR_RE.test(line[ch - 1] ?? '')
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

export function memberAccessAt(text: string | CursorSource, pos: Position): MemberAccess | null {
  const source = toCursorSource(text);
  const member = wordAt(source, pos);
  if (!member) return null;

  const line = source.sourceLines[pos.line];
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

function lexicalContextAt(source: CursorSource, pos: Position): LexicalContext {
  if (pos.line < 0 || pos.character < 0) return 'code';
  if (pos.line >= source.sourceLines.length) return 'code';

  const lineText = source.sourceLines[pos.line];
  const prepared = source.sourceLexicalLines?.[pos.line];
  let roles = prepared?.commentRoles;
  let lineComment = prepared?.lineComment;
  if (!prepared) {
    // Fallback sources retain the historical whole-prefix state scan. Exact
    // live ShaderLab analysis supplies the already-threaded per-line roles.
    let inBlockComment = false;
    for (let line = 0; line < pos.line; line++) {
      inBlockComment = scanCommentRoles(
        source.sourceLines[line],
        inBlockComment,
      ).inBlockComment;
    }
    const scan = scanCommentRoles(lineText, inBlockComment);
    roles = scan.roles;
    lineComment = scan.lineComment;
  }
  // Out of range past EOL: the old loop returned 'comment' only when a `//` had
  // run past the cursor (its early return), otherwise it fell through to 'code'.
  if (pos.character > lineText.length) {
    return lineComment ? 'comment' : 'code';
  }
  // roles has a trailing entry at [length] carrying the EOL state, so a cursor
  // at end-of-line inside an unterminated string still reports 'string'.
  const role = roles?.[pos.character];
  if (role === 'comment') return 'comment';
  if (role === 'stringQuote' || role === 'stringBody') return 'string';
  return 'code';
}

function isShaderLabDocument(languageId: string | undefined, uri: string): boolean {
  return languageId === 'shaderlab' || /\.shader(?:$|[?#])/i.test(uri);
}

function isInsideShaderLabHlslBlock(source: CursorSource, pos: Position): boolean {
  const blocks = source.blocks ?? scanBlocksFromExactSource(source).blocks;
  return blocks.some((block) =>
    pos.line >= block.contentStartLine && pos.line <= block.contentEndLine,
  );
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

function memberContextAt(lineText: string, prefix: CompletionPrefix): CursorMember | undefined {
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

function isShaderLabStateValuePosition(lineText: string, prefix: CompletionPrefix): boolean {
  const beforePrefix = lineText.slice(0, prefix.range.start.character).trimEnd();
  const match = /\b([A-Za-z][A-Za-z0-9_]*)$/.exec(beforePrefix);
  return match ? isShaderLabStateValueContext(match[1]) : false;
}

export interface CursorClassification {
  classification: SuggestionContextKind;
  lexical: LexicalContext;
  prefix: CompletionPrefix;
  member: CursorMember | undefined;
}

export function classifyCursor(
  text: string | CursorSource,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): CursorClassification {
  const source = toCursorSource(text);
  const lineText = source.sourceLines[pos.line] ?? '';
  const prefix = prefixAtLine(lineText, pos);
  const lexical = lexicalContextAt(source, pos);
  if (lexical !== 'code') {
    return { classification: lexical, lexical, prefix, member: undefined };
  }

  const baseKind: SuggestionContextKind = isShaderLabDocument(languageId, uri)
    && !isInsideShaderLabHlslBlock(source, pos)
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
  text: string | CursorSource,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): CursorContext {
  const source = toCursorSource(text);
  const c = classifyCursor(source, pos, languageId, uri);
  return {
    word: wordAt(source, pos),
    member: memberAccessAt(source, pos),
    lexical: c.lexical,
    classification: c.classification,
    prefix: c.prefix,
    memberPrefix: c.member,
  };
}
