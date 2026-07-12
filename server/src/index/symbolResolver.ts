import type { FileIndex, Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolReader } from './globalIndex';
import {
  selectNamedSymbolEntries,
  type SymbolSelectionOptions,
} from './symbolSelection';

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export type { ResolutionTrace } from './symbolSelection';
export type ResolutionOptions = SymbolSelectionOptions;

function asLink(symbol: SymbolEntry): LocationLink {
  return {
    targetUri: symbol.location.uri,
    targetRange: symbol.location.range,
    targetSelectionRange: symbol.location.range,
  };
}

export function resolveDefinitionSymbols(
  idx: FileIndex,
  name: string,
  refPos: Position,
  global?: GlobalSymbolReader | null,
  options?: ResolutionOptions,
): SymbolEntry[] {
  return selectNamedSymbolEntries(idx, name, refPos, global, options);
}

export function resolveDefinition(
  idx: FileIndex,
  name: string,
  refPos: Position,
  global?: GlobalSymbolReader | null,
  options?: ResolutionOptions,
): LocationLink[] {
  return resolveDefinitionSymbols(idx, name, refPos, global, options).map(asLink);
}
