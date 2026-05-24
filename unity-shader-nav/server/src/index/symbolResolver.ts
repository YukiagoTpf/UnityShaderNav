import type { FileIndex, Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex } from './globalIndex';
import { uriKey } from './uriKey';

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export interface ResolutionOptions {
  visibleUriKeys?: ReadonlySet<string>;
}

function inRange(pos: Position, range: Range): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

function isBeforeOrAt(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function asLink(symbol: SymbolEntry): LocationLink {
  return {
    targetUri: symbol.location.uri,
    targetRange: symbol.location.range,
    targetSelectionRange: symbol.location.range,
  };
}

function isVisible(symbol: SymbolEntry, options?: ResolutionOptions): boolean {
  return !options?.visibleUriKeys || options.visibleUriKeys.has(uriKey(symbol.location.uri));
}

export function resolveDefinitionSymbols(
  idx: FileIndex,
  name: string,
  refPos: Position,
  global?: GlobalSymbolIndex | null,
  options?: ResolutionOptions,
): SymbolEntry[] {
  const candidates = idx.symbols.filter((symbol) => symbol.name === name);
  const scoped = candidates.filter(
    (symbol) =>
      (symbol.kind === 'parameter' || symbol.kind === 'localVariable') &&
      symbol.scopeRange &&
      inRange(refPos, symbol.scopeRange) &&
      isBeforeOrAt(symbol.location.range.start, refPos),
  );

  if (scoped.length > 0) {
    let best = scoped[0];
    for (const symbol of scoped) {
      const symbolStart = symbol.location.range.start;
      const bestStart = best.location.range.start;
      if (
        symbolStart.line > bestStart.line ||
        (symbolStart.line === bestStart.line && symbolStart.character > bestStart.character)
      ) {
        best = symbol;
      }
    }
    return [best];
  }

  const fileGlobals = candidates.filter(
    (symbol) => symbol.kind !== 'parameter' && symbol.kind !== 'localVariable',
  );
  const otherGlobals = (global?.lookup(name) ?? []).filter(
    (symbol) =>
      symbol.location.uri !== idx.uri &&
      symbol.kind !== 'parameter' &&
      symbol.kind !== 'localVariable' &&
      isVisible(symbol, options),
  );

  return [...fileGlobals, ...otherGlobals];
}

export function resolveDefinition(
  idx: FileIndex,
  name: string,
  refPos: Position,
  global?: GlobalSymbolIndex | null,
  options?: ResolutionOptions,
): LocationLink[] {
  return resolveDefinitionSymbols(idx, name, refPos, global, options).map(asLink);
}
