import type { FileIndex, FunctionSymbolEntry, Position, SymbolEntry } from '@unity-shader-nav/shared';
import type { IndexStore } from '../index';
import { uriKey } from '../index/uriKey';
import type { ShaderSuggestion } from './types';

export interface CollectProjectSuggestionsInput {
  index: FileIndex;
  store: Pick<IndexStore, 'get' | 'uris'>;
  visibleUriKeys: ReadonlySet<string>;
  position: Position;
}

function inRange(pos: Position, range: NonNullable<SymbolEntry['scopeRange']>): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

function isBeforeOrAt(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function isScopedVisible(symbol: SymbolEntry, position: Position): boolean {
  return (symbol.kind === 'parameter' || symbol.kind === 'localVariable')
    && !!symbol.scopeRange
    && inRange(position, symbol.scopeRange)
    && isBeforeOrAt(symbol.location.range.start, position);
}

function laterThan(a: Position, b: Position): boolean {
  return a.line > b.line || (a.line === b.line && a.character > b.character);
}

function collectScopedSuggestions(index: FileIndex, position: Position): SymbolEntry[] {
  const byName = new Map<string, SymbolEntry>();
  for (const symbol of index.symbols) {
    if (!isScopedVisible(symbol, position)) continue;
    const previous = byName.get(symbol.name);
    if (!previous || laterThan(symbol.location.range.start, previous.location.range.start)) {
      byName.set(symbol.name, symbol);
    }
  }
  return [...byName.values()];
}

function isGlobalSuggestion(symbol: SymbolEntry): boolean {
  return symbol.kind !== 'parameter'
    && symbol.kind !== 'localVariable'
    && symbol.kind !== 'structMember';
}

function functionSignatureKey(symbol: FunctionSymbolEntry): string {
  return symbol.parameters.map((parameter) => parameter.type).join(',');
}

function rangeKey(symbol: SymbolEntry): string {
  const { range } = symbol.location;
  return [
    uriKey(symbol.location.uri),
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

function dedupeKey(symbol: SymbolEntry): string {
  if (symbol.kind === 'function') {
    return [
      symbol.name,
      symbol.kind,
      functionSignatureKey(symbol as FunctionSymbolEntry),
      rangeKey(symbol),
    ].join('|');
  }
  return [symbol.name, symbol.kind, symbol.parentType ?? ''].join('|');
}

export function symbolToSuggestion(symbol: SymbolEntry, sourceRank: number): ShaderSuggestion {
  const suggestion: ShaderSuggestion = {
    name: symbol.name,
    kind: symbol.kind,
    source: 'project',
    sortText: `${sourceRank}_${symbol.name}`,
    declaredType: symbol.declaredType,
    parentType: symbol.parentType,
  };
  if (symbol.kind === 'function') {
    const fn = symbol as FunctionSymbolEntry;
    suggestion.returnType = fn.returnType;
    suggestion.parameters = fn.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
    }));
  }
  return suggestion;
}

export function collectVisibleProjectSuggestions(input: CollectProjectSuggestionsInput): ShaderSuggestion[] {
  const ordered: Array<{ symbol: SymbolEntry; rank: number }> = [];
  for (const symbol of collectScopedSuggestions(input.index, input.position)) ordered.push({ symbol, rank: 0 });
  for (const symbol of input.index.symbols) {
    if (isGlobalSuggestion(symbol)) ordered.push({ symbol, rank: 1 });
  }
  for (const visibleKey of input.store.uris()) {
    if (uriKey(input.index.uri) === visibleKey || !input.visibleUriKeys.has(visibleKey)) continue;
    const visibleIndex = input.store.get(visibleKey);
    if (!visibleIndex) continue;
    for (const symbol of visibleIndex.symbols) {
      if (isGlobalSuggestion(symbol)) ordered.push({ symbol, rank: 2 });
    }
  }

  const seen = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  for (const candidate of ordered) {
    const key = dedupeKey(candidate.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(symbolToSuggestion(candidate.symbol, candidate.rank));
  }
  return suggestions;
}
