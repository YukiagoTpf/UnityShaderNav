import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type { GlobalSymbolReader } from './globalIndex';
import { inRange, isBeforeOrAt } from './positionGeometry';

export type ResolutionTrace = (event: string, data: Record<string, unknown>) => void;

export interface SymbolSelectionOptions {
  readonly visibleUriKeys?: ReadonlySet<string>;
  readonly trace?: ResolutionTrace;
}

export interface SymbolEntryGroups {
  readonly scoped: readonly SymbolEntry[];
  readonly currentGlobals: readonly SymbolEntry[];
  readonly visibleGlobals: readonly SymbolEntry[];
}

/** Batch selection for consumers that rank whole visible symbol sets. */
export function selectSymbolEntryGroups(
  index: FileIndex,
  position: Position,
  otherCandidates: Iterable<SymbolEntry>,
  options?: SymbolSelectionOptions,
): SymbolEntryGroups {
  const scopedByName = new Map<string, SymbolEntry>();
  const currentGlobals: SymbolEntry[] = [];
  for (const symbol of index.symbols) {
    if (!isScopedSymbol(symbol)) {
      currentGlobals.push(symbol);
      continue;
    }
    if (!isScopedVisible(symbol, position)) continue;
    const previous = scopedByName.get(symbol.name);
    if (!previous || declarationPrecedes(previous, symbol)) {
      scopedByName.set(symbol.name, symbol);
    }
  }

  const currentKey = uriKey(index.uri);
  const visibleGlobals: SymbolEntry[] = [];
  for (const symbol of otherCandidates) {
    if (
      uriKey(symbol.location.uri) !== currentKey
      && !isScopedSymbol(symbol)
      && isVisible(symbol, options)
    ) visibleGlobals.push(symbol);
  }
  return {
    scoped: [...scopedByName.values()],
    currentGlobals,
    visibleGlobals,
  };
}

export function selectNamedSymbolEntries(
  index: FileIndex,
  name: string,
  position: Position,
  global?: GlobalSymbolReader | null,
  options?: SymbolSelectionOptions,
): SymbolEntry[] {
  const currentCandidates = index.symbols.filter((symbol) => symbol.name === name);
  const scoped = currentCandidates.filter((symbol) => isScopedVisible(symbol, position));
  options?.trace?.('definition.candidates', {
    name,
    sameFileCandidates: currentCandidates.length,
    scopedCandidates: scoped.length,
  });

  const nearest = latestDeclaration(scoped);
  if (nearest) {
    options?.trace?.('definition.scopedSelected', describeSymbol(nearest));
    return [nearest];
  }

  const globals = selectGlobalSymbolEntries(index, name, global, options);
  options?.trace?.('definition.globalCandidates', {
    name,
    sameFileGlobals: globals.filter((symbol) => (
      uriKey(symbol.location.uri) === uriKey(index.uri)
    )).length,
    visibleOtherGlobals: globals.filter((symbol) => (
      uriKey(symbol.location.uri) !== uriKey(index.uri)
    )).length,
  });
  return globals;
}

/** Current-file globals first, followed by Include-visible cross-file globals. */
export function selectGlobalSymbolEntries(
  index: FileIndex,
  name: string,
  global?: GlobalSymbolReader | null,
  options?: SymbolSelectionOptions,
): SymbolEntry[] {
  const currentGlobals = index.symbols.filter((symbol) => (
    symbol.name === name && !isScopedSymbol(symbol)
  ));
  const currentKey = uriKey(index.uri);
  const visibleGlobals = (global?.lookup(name) ?? []).filter((symbol) => (
    uriKey(symbol.location.uri) !== currentKey
    && !isScopedSymbol(symbol)
    && isVisible(symbol, options)
  ));
  return [...currentGlobals, ...visibleGlobals];
}

/** One nearest visible parameter/local per name, in first-declaration order. */
export function selectScopedSymbolEntries(
  index: FileIndex,
  position: Position,
): SymbolEntry[] {
  return [...selectSymbolEntryGroups(index, position, []).scoped];
}

export function isScopedSymbol(symbol: SymbolEntry): boolean {
  return symbol.kind === 'parameter' || symbol.kind === 'localVariable';
}

function latestDeclaration(symbols: readonly SymbolEntry[]): SymbolEntry | undefined {
  let latest: SymbolEntry | undefined;
  for (const symbol of symbols) {
    if (
      !latest
      || declarationPrecedes(latest, symbol)
    ) latest = symbol;
  }
  return latest;
}

function isScopedVisible(symbol: SymbolEntry, position: Position): boolean {
  return isScopedSymbol(symbol)
    && !!symbol.scopeRange
    && inRange(position, symbol.scopeRange)
    && isBeforeOrAt(symbol.location.range.start, position);
}

function declarationPrecedes(left: SymbolEntry, right: SymbolEntry): boolean {
  return isBeforeOrAt(left.location.range.start, right.location.range.start);
}

function isVisible(
  symbol: SymbolEntry,
  options: SymbolSelectionOptions | undefined,
): boolean {
  return !options?.visibleUriKeys
    || options.visibleUriKeys.has(uriKey(symbol.location.uri));
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
