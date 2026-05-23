import type { FileIndex, Position, Range, SymbolEntry, SymbolKind } from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex } from './globalIndex';
import { resolveMemberSymbols } from './chainLookup';
import { resolveDefinitionSymbols } from './symbolResolver';
import { memberAccessAt, wordAt } from './wordAt';

export interface ReferenceTarget {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  scopeRange?: Range;
  parentType?: string;
}

function toReferenceTarget(symbol: SymbolEntry): ReferenceTarget {
  const target: ReferenceTarget = {
    name: symbol.name,
    kind: symbol.kind,
    uri: symbol.location.uri,
    range: symbol.location.range,
  };

  if (symbol.scopeRange) target.scopeRange = symbol.scopeRange;
  if (symbol.parentType) target.parentType = symbol.parentType;

  return target;
}

function containsPosition(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

export function resolveReferenceTargetsForName(
  index: FileIndex,
  name: string,
  position: Position,
  global?: GlobalSymbolIndex | null,
): ReferenceTarget[] {
  const scopedDeclarations = index.symbols.filter(
    (symbol) =>
      symbol.name === name &&
      (symbol.kind === 'parameter' || symbol.kind === 'localVariable') &&
      containsPosition(symbol.location.range, position),
  );
  if (scopedDeclarations.length > 0) return scopedDeclarations.map(toReferenceTarget);

  return resolveDefinitionSymbols(index, name, position, global).map(toReferenceTarget);
}

export function resolveReferenceTargets(
  index: FileIndex,
  text: string,
  position: Position,
  global?: GlobalSymbolIndex | null,
): ReferenceTarget[] {
  const memberAccess = memberAccessAt(text, position);
  if (memberAccess?.receiver) {
    const memberTargets = resolveMemberSymbols(
      index,
      global,
      memberAccess.receiver.text,
      memberAccess.member.text,
      position,
    );
    if (memberTargets.length > 0) return memberTargets.map(toReferenceTarget);
  }

  const word = wordAt(text, position);
  if (!word) return [];

  return resolveReferenceTargetsForName(index, word.text, position, global);
}
