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
  receiver: string,
  refPos: Position,
  options?: ResolutionOptions,
): string | null {
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
  options?.trace?.('member.receiverType', {
    receiver,
    source: crossFileGlobal ? 'visibleGlobal' : 'notFound',
    declaredType: crossFileGlobal?.declaredType,
    candidates: crossFileGlobal ? 1 : 0,
  });
  return crossFileGlobal?.declaredType ?? null;
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
  const receiverType = inferReceiverType(index, global, receiver, refPos, options);
  if (!receiverType) {
    options?.trace?.('member.noReceiverType', { receiver, member });
    return [];
  }

  const members = [
    ...index.symbols.filter(
      (symbol) =>
        symbol.kind === 'structMember' &&
        symbol.parentType === receiverType &&
        symbol.name === member,
    ),
    ...(global?.lookup(member) ?? []).filter(
      (symbol) =>
        symbol.kind === 'structMember' &&
        symbol.parentType === receiverType &&
        symbol.name === member &&
        isVisible(symbol, options),
    ),
  ];

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
