import type {
  FileIndex,
  FunctionSymbolEntry,
  Position,
  Range,
  ReferenceEntry,
  SymbolEntry,
  SymbolKind,
} from '@unity-shader-nav/shared';
import type { GlobalSymbolReader } from './globalIndex';
import type { CursorTarget } from './cursorTarget';
import { resolveMemberSymbols } from './chainLookup';
import { containsPosition } from '../sourceLocation';
import { resolveDefinitionSymbols, type ResolutionOptions } from './symbolResolver';
import { selectGlobalSymbolEntries } from './symbolSelection';
import { memberAccessAt } from '../parser/lexical/cursor';
import { locationKey } from '../sourceLocation';
import { uriKey } from '../uriKey';

export interface ReferenceTarget {
  name: string;
  kind: SymbolKind;
  uri: string;
  range: Range;
  scopeRange?: Range;
  parentType?: string;
  methodSignature?: string;
}

export function methodSignatureOf(symbol: SymbolEntry): string | undefined {
  if (symbol.kind !== 'function' || !symbol.parentType) return undefined;
  const fn = symbol as FunctionSymbolEntry;
  return [
    fn.returnType,
    fn.parameters.map((parameter) => parameter.type).join(','),
  ].join('|');
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
  const methodSignature = methodSignatureOf(symbol);
  if (methodSignature) target.methodSignature = methodSignature;

  return target;
}

function isExactDeclarationTarget(symbol: SymbolEntry): boolean {
  return symbol.kind === 'parameter'
    || symbol.kind === 'localVariable'
    || !!symbol.parentType;
}

export function resolveReferenceTargetsForName(
  index: FileIndex,
  name: string,
  position: Position,
  global?: GlobalSymbolReader | null,
  options?: ResolutionOptions,
): ReferenceTarget[] {
  const exactDeclarations = index.symbols.filter(
    (symbol) =>
      symbol.name === name &&
      isExactDeclarationTarget(symbol) &&
      containsPosition(symbol.location.range, position),
  );
  if (exactDeclarations.length > 0) {
    const expanded = exactDeclarations.flatMap((declaration) => {
      const signature = methodSignatureOf(declaration);
      if (!signature || !declaration.parentType) return [declaration];
      return selectGlobalSymbolEntries(index, name, global, options).filter((candidate) => (
        candidate.kind === 'function'
        && candidate.parentType === declaration.parentType
        && methodSignatureOf(candidate) === signature
      ));
    });
    const seen = new Set<string>();
    return expanded.filter((symbol) => {
      const key = locationKey(uriKey(symbol.location.uri), symbol.location.range);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(toReferenceTarget);
  }

  return resolveDefinitionSymbols(index, name, position, global, options).map(toReferenceTarget);
}

export function resolveReferenceTargets(
  index: FileIndex,
  text: string,
  position: Position,
  global?: GlobalSymbolReader | null,
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

  if (!memberAccess) return [];

  return resolveReferenceTargetsForName(
    index,
    memberAccess.member.text,
    position,
    global,
    options,
  );
}

export function resolveReferenceTargetsForCursor(
  index: FileIndex,
  target: CursorTarget,
  position: Position,
  global?: GlobalSymbolReader | null,
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
  global?: GlobalSymbolReader | null,
  options?: ResolutionOptions,
): ReferenceTarget[] {
  if (!reference.receiver) return [];

  return resolveMemberSymbols(
    index,
    global,
    reference.receiver,
    reference.name,
    reference.location.range.start,
    options,
  ).map(toReferenceTarget);
}
