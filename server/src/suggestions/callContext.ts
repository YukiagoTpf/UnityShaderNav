import type { Position, Range } from '@unity-shader-nav/shared';
import { scanCommentRoles, type CommentScan } from '../parser/masking';
import { exactSource, type ExactSource } from '../sourceLocation';

const ID_CHAR_RE = /[A-Za-z0-9_]/;
const ID_START_RE = /[A-Za-z_]/;
const MAX_SCAN_LINES = 128;
const MAX_SCAN_CHARACTERS = 32 * 1024;

export type CallTarget = {
  readonly kind: 'free';
  readonly name: string;
  readonly range: Range;
} | {
  readonly kind: 'member';
  readonly receiver: string;
  readonly name: string;
  readonly range: Range;
};

export interface CallContext {
  target: CallTarget;
  argumentListStart: Position;
  activeParameter: number;
}

interface CallOpen {
  readonly line: number;
  readonly character: number;
}

interface LocatedCall {
  readonly open: CallOpen;
  readonly target: CallTarget;
}

interface MaskedCallWindow {
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly cursorIsCode: boolean;
}

interface ScanBudget {
  remaining: number;
}

export function callContextAt(text: string | ExactSource, position: Position): CallContext | null {
  const source = exactSource(
    typeof text === 'string' ? text : text.sourceText,
    typeof text === 'string' ? undefined : text,
  );
  const line = source.sourceLines[position.line];
  if (line === undefined || position.character < 0 || position.character > line.length) return null;

  const budget: ScanBudget = { remaining: MAX_SCAN_CHARACTERS };
  const window = maskCallWindow(source, position, budget);
  if (!window) return null;
  if (!window.cursorIsCode) return null;
  const call = findCall(window.lines, window.startLine, position, budget);
  if (!call) return null;
  const { open: callOpen, target } = call;
  if (looksLikeFunctionDeclaration(
    window.lines,
    window.startLine,
    callOpen.line,
    target.range.start.character,
    budget,
  )) {
    return null;
  }

  const activeParameter = countActiveParameter(window.lines, callOpen, position, budget);
  if (activeParameter === null) return null;

  return {
    target,
    argumentListStart: { line: callOpen.line, character: callOpen.character + 1 },
    activeParameter,
  };
}

function maskCallWindow(
  source: ExactSource,
  position: Position,
  budget: ScanBudget,
): MaskedCallWindow | null {
  const startLine = Math.max(0, position.line - MAX_SCAN_LINES + 1);
  const masked: string[] = [];
  let inBlockComment = false;
  let cursorIsCode = true;
  const preparedLines = source.sourceLexicalLines;
  const preparedBlockStates = source.sourceBlockCommentStates;
  const hasCompletePreparedLines = (preparedLines?.length ?? 0) > position.line;
  const hasCompletePreparedStates = (preparedBlockStates?.length ?? 0) > position.line;
  const hasPreparedEntryState = hasCompletePreparedLines || hasCompletePreparedStates;
  const lexicalStartLine = hasPreparedEntryState ? startLine : 0;

  for (let line = lexicalStartLine; line <= position.line; line++) {
    const rawText = source.sourceLines[line] ?? '';
    const text = line === position.line
      ? rawText.slice(0, position.character)
      : rawText;
    const prepared = hasCompletePreparedLines ? preparedLines?.[line] : undefined;
    const scan: CommentScan | undefined = prepared
      ? undefined
      : scanCommentRoles(
        text,
        hasCompletePreparedStates ? preparedBlockStates?.[line] ?? false : inBlockComment,
      );
    const roles = prepared?.commentRoles ?? scan!.roles;
    if (scan) inBlockComment = scan.inBlockComment;
    if (line < startLine) continue;
    if (!consumeBudget(budget, text.length * (prepared ? 1 : 2) + 1)) return null;
    const characters = text.split('');
    for (let index = 0; index < characters.length; index++) {
      if (roles[index] !== 'code') characters[index] = ' ';
    }
    masked[line] = characters.join('');
    if (line === position.line) {
      cursorIsCode = isCodeAtCursor(rawText, position.character, roles[position.character]);
    }
  }

  return { lines: masked, startLine, cursorIsCode };
}

function looksLikeFunctionDeclaration(
  lines: readonly string[],
  startLine: number,
  calleeLine: number,
  calleeStart: number,
  budget: ScanBudget,
): boolean {
  const prefixLines = lines.slice(startLine, calleeLine);
  prefixLines.push((lines[calleeLine] ?? '').slice(0, calleeStart));
  const statement = prefixLines.join('\n');
  if (!consumeBudget(budget, statement.length)) return true;
  let boundary = -1;
  for (let index = 0; index < statement.length; index++) {
    if (/[=+\-/%!?|^~;,[{()}]/.test(statement[index])) boundary = index;
  }
  const before = statement.slice(boundary + 1).trimEnd();
  if (/\b(?:return|if|for|while|switch|case|else|do|sizeof)\s*$/.test(before)) return false;
  if (/\b[A-Za-z_][A-Za-z0-9_<>,\s*&]*\s+[A-Za-z_][A-Za-z0-9_]*::\s*$/.test(before)) {
    return true;
  }
  return /\b[A-Za-z_][A-Za-z0-9_<>,\s*&]*$/.test(before)
    && !/:/.test(before);
}

function findCall(
  lines: readonly string[],
  firstLine: number,
  position: Position,
  budget: ScanBudget,
): LocatedCall | null {
  let parenDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  for (let line = position.line; line >= firstLine; line--) {
    const text = lines[line] ?? '';
    const end = line === position.line ? position.character : text.length;
    for (let character = end - 1; character >= 0; character--) {
      if (!consumeBudget(budget, 1)) return null;
      const ch = text[character];
      if (ch === ')') {
        parenDepth++;
        continue;
      }
      if (ch === ']') {
        squareDepth++;
        continue;
      }
      if (ch === '}') {
        braceDepth++;
        continue;
      }
      if (ch === '(') {
        if (parenDepth > 0) {
          parenDepth--;
          continue;
        }
        if (squareDepth === 0 && braceDepth === 0) {
          const open = { line, character };
          const target = targetBefore(text, open);
          if (target) return { open, target };
        }
      }
      if (ch === '[' && squareDepth > 0) {
        squareDepth--;
        continue;
      }
      if (ch === '{' && braceDepth > 0) braceDepth--;
    }
    if (!consumeBudget(budget, 1)) return null;
  }

  return null;
}

function targetBefore(line: string, open: CallOpen): CallTarget | null {
  let end = open.character;
  while (end > 0 && /\s/.test(line[end - 1])) end--;
  let start = end;
  while (start > 0 && ID_CHAR_RE.test(line[start - 1])) start--;
  if (start === end) return null;
  const name = line.slice(start, end);
  if (!ID_START_RE.test(name[0] ?? '')) return null;
  const range = {
    start: { line: open.line, character: start },
    end: { line: open.line, character: end },
  };
  if (line[start - 1] === '.') {
    const receiverEnd = start - 1;
    const receiverStart = receiverExpressionStart(line, receiverEnd);
    const receiver = line.slice(receiverStart, receiverEnd);
    if (!ID_START_RE.test(receiver[0] ?? '')) return null;
    return { kind: 'member', receiver, name, range };
  }
  return {
    kind: 'free',
    name,
    range,
  };
}

function receiverExpressionStart(line: string, end: number): number {
  let cursor = end - 1;
  let squareDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;

  while (cursor >= 0) {
    const ch = line[cursor];
    if (ch === ']') squareDepth++;
    else if (ch === ')') parenDepth++;
    else if (ch === '}') braceDepth++;
    else if (ch === '[' && squareDepth > 0) squareDepth--;
    else if (ch === '(' && parenDepth > 0) parenDepth--;
    else if (ch === '{' && braceDepth > 0) braceDepth--;
    else if (
      squareDepth === 0
      && parenDepth === 0
      && braceDepth === 0
      && !ID_CHAR_RE.test(ch)
      && ch !== '.'
    ) break;
    cursor--;
  }

  return cursor + 1;
}

function countActiveParameter(
  lines: readonly string[],
  open: CallOpen,
  position: Position,
  budget: ScanBudget,
): number | null {
  let parenDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  let activeParameter = 0;

  for (let line = open.line; line <= position.line; line++) {
    const text = lines[line] ?? '';
    const start = line === open.line ? open.character + 1 : 0;
    const end = line === position.line ? position.character : text.length;
    for (let character = start; character < end; character++) {
      if (!consumeBudget(budget, 1)) return null;
      const ch = text[character];
      if (ch === '(') parenDepth++;
      else if (ch === ')') {
        if (parenDepth === 0) return null;
        parenDepth--;
      } else if (ch === '[') squareDepth++;
      else if (ch === ']') {
        if (squareDepth === 0) return null;
        squareDepth--;
      } else if (ch === '{') braceDepth++;
      else if (ch === '}') {
        if (braceDepth === 0) return null;
        braceDepth--;
      } else if (ch === ',' && parenDepth === 0 && squareDepth === 0 && braceDepth === 0) {
        activeParameter++;
      }
    }
  }

  return activeParameter;
}

function consumeBudget(budget: ScanBudget, amount: number): boolean {
  if (amount > budget.remaining) return false;
  budget.remaining -= amount;
  return true;
}

function isCodeAtCursor(
  line: string,
  character: number,
  scannedRole: CommentScan['roles'][number] | undefined,
): boolean {
  if (scannedRole !== 'code') return false;
  const previous = line[character - 1];
  const current = line[character];
  const next = line[character + 1];
  if (current === '"') return false;
  if (current === '/' && (next === '/' || next === '*')) return false;
  return !(previous === '/' && (current === '/' || current === '*'));
}
