import type { FileIndex, FunctionSymbolEntry, Position, SymbolEntry } from '@unity-shader-nav/shared';
import {
  containsPosition,
  isBeforeOrAt,
  locationKey,
  symbolToLocationLink,
  type LocationLink,
} from '../sourceLocation';
import type { GlobalSymbolReader } from './globalIndex';
import type { ResolutionOptions } from './symbolResolver';
import {
  selectGlobalSymbolEntries,
  selectNamedSymbolEntries,
} from './symbolSelection';

function laterThan(a: Position, b: Position): boolean {
  return a.line > b.line || (a.line === b.line && a.character > b.character);
}

function inferReceiverType(
  index: FileIndex,
  global: GlobalSymbolReader | null | undefined,
  receiverTypeName: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
  const receiver = receiverTypeName;
  const selected = selectNamedSymbolEntries(index, receiver, refPos, global, options);
  const value = selected.find((symbol) => (
    (symbol.kind === 'parameter'
      || symbol.kind === 'localVariable'
      || symbol.kind === 'variable')
    && symbol.declaredType
  ));
  if (value?.declaredType) {
    options?.trace?.('member.receiverType', {
      receiver,
      source: value.kind,
      declaredType: value.declaredType,
      candidates: selected.length,
    });
    return value.declaredType;
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
  global: GlobalSymbolReader | null | undefined,
  receiver: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
  const inferences = index.typeInferences?.filter(
    (entry) =>
      entry.receiver === receiver &&
      entry.scopeRange &&
      containsPosition(entry.scopeRange, refPos) &&
      isBeforeOrAt(entry.assignmentRange.end, refPos),
  ) ?? [];
  if (inferences.length === 0) return null;

  let best = inferences[0];
  for (const entry of inferences) {
    if (laterThan(entry.assignmentRange.start, best.assignmentRange.start)) best = entry;
  }

  const functions = selectGlobalSymbolEntries(
    index,
    best.callName,
    global,
    options,
  ).filter(isFunctionWithReturnType);
  const seen = new Set<string>();
  const unique = functions.filter((symbol) => {
    const key = locationKey(symbol.location.uri, symbol.location.range);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const inferredReturnType = unique[0]?.returnType;
  if (
    inferredReturnType === undefined
    || unique.some((symbol) => symbol.returnType !== inferredReturnType)
  ) {
    options?.trace?.('member.callAssignmentAmbiguous', {
      receiver,
      callName: best.callName,
      candidates: unique.length,
    });
    return null;
  }

  return inferredReturnType;
}

function isFunctionWithReturnType(symbol: SymbolEntry): symbol is FunctionSymbolEntry {
  return symbol.kind === 'function' && typeof (symbol as { returnType?: unknown }).returnType === 'string';
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

function structMembersFor(
  index: FileIndex,
  global: GlobalSymbolReader | null | undefined,
  parentType: string,
  member: string,
  options?: ResolutionOptions,
): SymbolEntry[] {
  return selectGlobalSymbolEntries(index, member, global, options)
    .filter((symbol) => (
      symbol.kind === 'structMember'
      && symbol.parentType === parentType
    ));
}

function inferReceiverExpressionType(
  index: FileIndex,
  global: GlobalSymbolReader | null | undefined,
  receiver: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
  const expression = parseReceiverExpression(receiver);
  if (!expression) return null;

  const rootType = inferReceiverType(index, global, expression.root, refPos, options);
  if (!rootType) return null;
  let currentType: string = rootType;

  for (const field of expression.fields) {
    const nextMember: SymbolEntry | undefined = structMembersFor(index, global, currentType, field, options)
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

export function inferReceiverTypeForCompletion(
  index: FileIndex,
  global: GlobalSymbolReader | null | undefined,
  receiver: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
  return inferReceiverExpressionType(index, global, receiver, refPos, options);
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
  global: GlobalSymbolReader | null | undefined,
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
    const key = locationKey(symbol.location.uri, symbol.location.range);
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
  global: GlobalSymbolReader | null | undefined,
  receiver: string,
  member: string,
  refPos: Position,
  options?: ResolutionOptions,
): LocationLink[] {
  return resolveMemberSymbols(index, global, receiver, member, refPos, options)
    .map((symbol) => symbolToLocationLink(symbol));
}
