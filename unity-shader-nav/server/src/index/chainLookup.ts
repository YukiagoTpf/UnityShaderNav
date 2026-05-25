import type { FileIndex, Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex } from './globalIndex';
import type { LocationLink, ResolutionOptions } from './symbolResolver';
import { uriKey } from './uriKey';

function inRange(pos: Position, range: Range): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

function isBeforeOrAt(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function laterThan(a: Position, b: Position): boolean {
  return a.line > b.line || (a.line === b.line && a.character > b.character);
}

function inferReceiverType(
  index: FileIndex,
  global: GlobalSymbolIndex | null | undefined,
  receiverTypeName: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
  const receiver = rootIdentifier(receiverTypeName);
  const params = index.symbols.filter(
    (symbol) =>
      symbol.name === receiver &&
      symbol.kind === 'parameter' &&
      symbol.declaredType &&
      symbol.scopeRange &&
      inRange(refPos, symbol.scopeRange),
  );
  if (params.length > 0) {
    options?.trace?.('member.receiverType', {
      receiver,
      source: 'parameter',
      declaredType: params[0].declaredType,
      candidates: params.length,
    });
    return params[0].declaredType ?? null;
  }

  const locals = index.symbols.filter(
    (symbol) =>
      symbol.name === receiver &&
      symbol.kind === 'localVariable' &&
      symbol.declaredType &&
      symbol.scopeRange &&
      inRange(refPos, symbol.scopeRange) &&
      isBeforeOrAt(symbol.location.range.start, refPos),
  );
  if (locals.length > 0) {
    let best = locals[0];
    for (const local of locals) {
      if (laterThan(local.location.range.start, best.location.range.start)) best = local;
    }
    options?.trace?.('member.receiverType', {
      receiver,
      source: 'localVariable',
      declaredType: best.declaredType,
      candidates: locals.length,
    });
    return best.declaredType ?? null;
  }

  const fileGlobal = index.symbols.find(
    (symbol) => symbol.name === receiver && symbol.kind === 'variable' && symbol.declaredType,
  );
  if (fileGlobal?.declaredType) {
    options?.trace?.('member.receiverType', {
      receiver,
      source: 'fileGlobal',
      declaredType: fileGlobal.declaredType,
      candidates: 1,
    });
    return fileGlobal.declaredType;
  }

  const crossFileGlobal = (global?.lookup(receiver) ?? []).find(
    (symbol) =>
      symbol.kind === 'variable' &&
      symbol.declaredType &&
      isVisible(symbol, options),
  );
  if (crossFileGlobal?.declaredType) {
    options?.trace?.('member.receiverType', {
      receiver,
      source: 'visibleGlobal',
      declaredType: crossFileGlobal.declaredType,
      candidates: 1,
    });
    return crossFileGlobal.declaredType;
  }

  const inferredType = inferReceiverTypeFromCallAssignment(index, global, receiver, refPos, options);
  options?.trace?.('member.receiverType', {
    receiver,
    source: inferredType ? 'callAssignment' : 'notFound',
    declaredType: inferredType,
    candidates: inferredType ? 1 : 0,
  });
  return inferredType;
}

function inferReceiverTypeFromCallAssignment(
  index: FileIndex,
  global: GlobalSymbolIndex | null | undefined,
  receiver: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
  const inferences = index.typeInferences?.filter(
    (entry) =>
      entry.receiver === receiver &&
      entry.scopeRange &&
      inRange(refPos, entry.scopeRange) &&
      isBeforeOrAt(entry.assignmentRange.end, refPos),
  ) ?? [];
  if (inferences.length === 0) return null;

  let best = inferences[0];
  for (const entry of inferences) {
    if (laterThan(entry.assignmentRange.start, best.assignmentRange.start)) best = entry;
  }

  const functions = [
    ...index.symbols.filter(
      (symbol) =>
        symbol.name === best.callName &&
        symbol.kind === 'function' &&
        typeof (symbol as { returnType?: unknown }).returnType === 'string',
    ),
    ...(global?.lookup(best.callName) ?? []).filter(
      (symbol) =>
        symbol.kind === 'function' &&
        typeof (symbol as { returnType?: unknown }).returnType === 'string' &&
        isVisible(symbol, options),
    ),
  ];
  const seen = new Set<string>();
  const unique = functions.filter((symbol) => {
    const key = linkKey(symbol);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length !== 1) {
    options?.trace?.('member.callAssignmentAmbiguous', {
      receiver,
      callName: best.callName,
      candidates: unique.length,
    });
    return null;
  }

  return (unique[0] as { returnType: string }).returnType;
}

function rootIdentifier(receiver: string): string {
  const match = receiver.match(/[A-Za-z_][A-Za-z0-9_]*/);
  return match?.[0] ?? receiver;
}

interface ReceiverExpression {
  root: string;
  fields: string[];
}

function parseReceiverExpression(receiver: string): ReceiverExpression | null {
  let cursor = 0;
  const root = readIdentifier(receiver, cursor);
  if (!root) return null;
  cursor = root.end;
  const fields: string[] = [];

  while (cursor < receiver.length) {
    const ch = receiver[cursor];
    if (ch === '[') {
      const next = skipBalanced(receiver, cursor, '[', ']');
      if (next === cursor) return null;
      cursor = next;
      continue;
    }
    if (ch === '.') {
      const field = readIdentifier(receiver, cursor + 1);
      if (!field) return null;
      fields.push(field.text);
      cursor = field.end;
      continue;
    }
    if (/\s/.test(ch)) {
      cursor++;
      continue;
    }
    return null;
  }

  return { root: root.text, fields };
}

function readIdentifier(text: string, start: number): { text: string; end: number } | null {
  if (!/[A-Za-z_]/.test(text[start] ?? '')) return null;
  let end = start + 1;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
  return { text: text.slice(start, end), end };
}

function skipBalanced(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let cursor = start; cursor < text.length; cursor++) {
    if (text[cursor] === open) depth++;
    if (text[cursor] === close) {
      depth--;
      if (depth === 0) return cursor + 1;
    }
  }
  return start;
}

function isVisible(symbol: SymbolEntry, options?: ResolutionOptions): boolean {
  return !options?.visibleUriKeys || options.visibleUriKeys.has(uriKey(symbol.location.uri));
}

function linkKey(symbol: SymbolEntry): string {
  const range = symbol.location.range;
  return [
    symbol.location.uri,
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

function toLink(symbol: SymbolEntry): LocationLink {
  return {
    targetUri: symbol.location.uri,
    targetRange: symbol.location.range,
    targetSelectionRange: symbol.location.range,
  };
}

function structMembersFor(
  index: FileIndex,
  global: GlobalSymbolIndex | null | undefined,
  parentType: string,
  member: string,
  options?: ResolutionOptions,
): SymbolEntry[] {
  return [
    ...index.symbols.filter(
      (symbol) =>
        symbol.kind === 'structMember' &&
        symbol.parentType === parentType &&
        symbol.name === member,
    ),
    ...(global?.lookup(member) ?? []).filter(
      (symbol) =>
        symbol.kind === 'structMember' &&
        symbol.parentType === parentType &&
        symbol.name === member &&
        isVisible(symbol, options),
    ),
  ];
}

function inferReceiverExpressionType(
  index: FileIndex,
  global: GlobalSymbolIndex | null | undefined,
  receiver: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
  const expression = parseReceiverExpression(receiver);
  if (!expression) return inferReceiverType(index, global, receiver, refPos, options);

  let currentType = inferReceiverType(index, global, expression.root, refPos, options);
  if (!currentType) return null;

  for (const field of expression.fields) {
    const nextMember = structMembersFor(index, global, currentType, field, options)
      .find((symbol) => symbol.declaredType);
    if (!nextMember?.declaredType) {
      options?.trace?.('member.noNestedType', {
        receiver,
        field,
        parentType: currentType,
      });
      return null;
    }
    currentType = nextMember.declaredType;
  }

  return currentType;
}

function describeSymbol(symbol: SymbolEntry): Record<string, unknown> {
  return {
    name: symbol.name,
    kind: symbol.kind,
    uri: symbol.location.uri,
    range: symbol.location.range,
    declaredType: symbol.declaredType,
    parentType: symbol.parentType,
  };
}

export function resolveMemberSymbols(
  index: FileIndex,
  global: GlobalSymbolIndex | null | undefined,
  receiver: string,
  member: string,
  refPos: Position,
  options?: ResolutionOptions,
): SymbolEntry[] {
  const receiverType = inferReceiverExpressionType(index, global, receiver, refPos, options);
  if (!receiverType) {
    options?.trace?.('member.noReceiverType', { receiver, member });
    return [];
  }

  const members = structMembersFor(index, global, receiverType, member, options);

  const seen = new Set<string>();
  const unique = members.filter((symbol) => {
    const key = linkKey(symbol);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  options?.trace?.('member.candidates', {
    receiver,
    member,
    receiverType,
    candidates: unique.length,
    symbols: unique.slice(0, 5).map(describeSymbol),
  });

  return unique;
}

export function resolveMember(
  index: FileIndex,
  global: GlobalSymbolIndex | null | undefined,
  receiver: string,
  member: string,
  refPos: Position,
  options?: ResolutionOptions,
): LocationLink[] {
  return resolveMemberSymbols(index, global, receiver, member, refPos, options).map(toLink);
}
