import type {
  FileIndex,
  Position,
  Range,
  ReferenceEntry,
  SymbolEntry,
  SymbolKind,
} from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex } from './globalIndex';
import type { CursorTarget } from './cursorTarget';
import { resolveMemberSymbols } from './chainLookup';
import { resolveDefinitionSymbols, type ResolutionOptions } from './symbolResolver';
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

function isExactDeclarationTarget(symbol: SymbolEntry): boolean {
  return symbol.kind === 'parameter' || symbol.kind === 'localVariable' || symbol.kind === 'structMember';
}

export function resolveReferenceTargetsForName(
  index: FileIndex,
  name: string,
  position: Position,
  global?: GlobalSymbolIndex | null,
  options?: ResolutionOptions,
): ReferenceTarget[] {
  const exactDeclarations = index.symbols.filter(
    (symbol) =>
      symbol.name === name &&
      isExactDeclarationTarget(symbol) &&
      containsPosition(symbol.location.range, position),
  );
  if (exactDeclarations.length > 0) return exactDeclarations.map(toReferenceTarget);

  return resolveDefinitionSymbols(index, name, position, global, options).map(toReferenceTarget);
}

export function resolveReferenceTargets(
  index: FileIndex,
  text: string,
  position: Position,
  global?: GlobalSymbolIndex | null,
  options?: ResolutionOptions,
): ReferenceTarget[] {
  const memberAccess = memberAccessAt(text, position);
  if (memberAccess?.receiver) {
    const memberTargets = resolveMemberSymbols(
      index,
      global,
      memberAccess.receiver.text,
      memberAccess.member.text,
      position,
      options,
    );
    if (memberTargets.length > 0) return memberTargets.map(toReferenceTarget);
  }

  const word = wordAt(text, position);
  if (!word) return [];

  return resolveReferenceTargetsForName(index, word.text, position, global, options);
}

export function resolveReferenceTargetsForCursor(
  index: FileIndex,
  target: CursorTarget,
  position: Position,
  global?: GlobalSymbolIndex | null,
  options?: ResolutionOptions,
): ReferenceTarget[] {
  if (target.kind === 'member') {
    const memberTargets = resolveMemberSymbols(
      index,
      global,
      target.receiver.text,
      target.member.text,
      position,
      options,
    ).map(toReferenceTarget);
    if (memberTargets.length > 0) return memberTargets;
    return resolveReferenceTargetsForName(index, target.member.text, position, global, options);
  }
  if (target.kind === 'symbol') {
    return resolveReferenceTargetsForName(index, target.word.text, position, global, options);
  }
  return [];
}

export function resolveReferenceTargetsForMemberReference(
  index: FileIndex,
  reference: ReferenceEntry,
  global?: GlobalSymbolIndex | null,
  options?: ResolutionOptions,
): ReferenceTarget[] {
  if (reference.context !== 'member' || !reference.receiver) return [];

  return resolveMemberSymbols(
    index,
    global,
    reference.receiver,
    reference.name,
    reference.location.range.start,
    options,
  ).map(toReferenceTarget);
}
