import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import {
  symbolToLocationLink,
  type LocationLink,
} from '../sourceLocation';
import type { GlobalSymbolReader } from './globalIndex';
import {
  selectNamedSymbolEntries,
  type SymbolSelectionOptions,
} from './symbolSelection';

export type { ResolutionTrace } from './symbolSelection';
export type ResolutionOptions = SymbolSelectionOptions;

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
  return resolveDefinitionSymbols(idx, name, refPos, global, options)
    .map((symbol) => symbolToLocationLink(symbol));
}
