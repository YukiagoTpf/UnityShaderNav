import type { Position, Range } from '@unity-shader-nav/shared';

const ID_CHAR_RE = /[A-Za-z0-9_]/;
const ID_START_RE = /[A-Za-z_]/;

export interface CallContext {
  calleeName: string;
  calleeRange: Range;
  argumentListStart: Position;
  activeParameter: number;
}

export function callContextAt(text: string, position: Position): CallContext | null {
  const lines = text.split(/\r?\n/);
  const line = lines[position.line];
  if (line === undefined || position.character < 0 || position.character > line.length) return null;

  const openParen = findCallOpenParen(line, position.character);
  if (openParen === null) return null;

  const callee = calleeBefore(line, openParen);
  if (!callee) return null;
  if (line[callee.start - 1] === '.') return null;
  if (looksLikeFunctionDeclaration(line, callee.start)) return null;

  const activeParameter = countActiveParameter(line, openParen + 1, position.character);
  if (activeParameter === null) return null;

  return {
    calleeName: callee.name,
    calleeRange: {
      start: { line: position.line, character: callee.start },
      end: { line: position.line, character: callee.end },
    },
    argumentListStart: { line: position.line, character: openParen + 1 },
    activeParameter,
  };
}

function looksLikeFunctionDeclaration(line: string, calleeStart: number): boolean {
  const before = line.slice(0, calleeStart).trimEnd();
  if (/\b(?:return|if|for|while|switch|case|sizeof)\s*$/.test(before)) return false;
  return /\b[A-Za-z_][A-Za-z0-9_<>,\s*&]*$/.test(before)
    && !/[=+\-/%!?|^~:;,[{()}]/.test(before);
}

function findCallOpenParen(line: string, end: number): number | null {
  let parenDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;

  for (let cursor = end - 1; cursor >= 0; cursor--) {
    const ch = line[cursor];
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
      if (squareDepth === 0 && braceDepth === 0) return cursor;
    }
    if (ch === '[' && squareDepth > 0) {
      squareDepth--;
      continue;
    }
    if (ch === '{' && braceDepth > 0) {
      braceDepth--;
    }
  }

  return null;
}

function calleeBefore(line: string, openParen: number): { name: string; start: number; end: number } | null {
  let end = openParen;
  while (end > 0 && /\s/.test(line[end - 1])) end--;
  let start = end;
  while (start > 0 && ID_CHAR_RE.test(line[start - 1])) start--;
  if (start === end) return null;
  const name = line.slice(start, end);
  if (!ID_START_RE.test(name[0] ?? '')) return null;
  return { name, start, end };
}

function countActiveParameter(line: string, start: number, end: number): number | null {
  let parenDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  let activeParameter = 0;

  for (let cursor = start; cursor < end; cursor++) {
    const ch = line[cursor];
    if (ch === '(') parenDepth++;
    else if (ch === ')') {
      if (parenDepth === 0) return activeParameter;
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

  return activeParameter;
}
