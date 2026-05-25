import type { Location } from 'vscode-languageserver/node';
import type {
  FileIndex,
  Range,
  ReferenceContext,
  SymbolEntry,
  SymbolKind,
} from '@unity-shader-nav/shared';
import type { ReferenceTarget } from '../index';

function samePosition(a: Range['start'], b: Range['start']): boolean {
  return a.line === b.line && a.character === b.character;
}

export function sameRange(a: Range, b: Range): boolean {
  return samePosition(a.start, b.start) && samePosition(a.end, b.end);
}

export function containsPosition(range: Range, position: Range['start']): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

export function sameTarget(a: ReferenceTarget, b: ReferenceTarget): boolean {
  return a.kind === b.kind && a.uri === b.uri && sameRange(a.range, b.range);
}

export function symbolToTarget(symbol: SymbolEntry): ReferenceTarget {
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

export function isScopedTarget(target: ReferenceTarget): boolean {
  return (target.kind === 'localVariable' || target.kind === 'parameter') && !!target.scopeRange;
}

export function isMemberTarget(target: ReferenceTarget): boolean {
  return target.kind === 'structMember' && !!target.parentType;
}

export function isGlobalKindAwareTarget(target: ReferenceTarget): boolean {
  return !isScopedTarget(target) && !isMemberTarget(target);
}

function compatibleReferenceContexts(kind: SymbolKind): readonly ReferenceContext[] {
  switch (kind) {
    case 'function':
      return ['call', 'pragma'];
    case 'struct':
      return ['type'];
    case 'macro':
      return ['identifier', 'call'];
    case 'variable':
    case 'cbuffer':
      return ['identifier', 'member'];
    case 'structMember':
      return ['member'];
    case 'parameter':
    case 'localVariable':
      return ['identifier'];
  }
}

export function isReferenceContextCompatible(target: ReferenceTarget, context: ReferenceContext): boolean {
  return compatibleReferenceContexts(target.kind).includes(context);
}

export function narrowGlobalTargetsForOccurrence(
  targets: ReferenceTarget[],
  index: FileIndex | undefined,
  name: string,
  position: Range['start'],
): ReferenceTarget[] {
  if (!index || targets.length <= 1) return targets;

  const occurrenceContexts = index.references
    .filter((reference) =>
      reference.name === name && containsPosition(reference.location.range, position),
    )
    .map((reference) => reference.context);
  if (occurrenceContexts.length > 0) {
    return targets.filter((target) =>
      occurrenceContexts.some((context) => isReferenceContextCompatible(target, context)),
    );
  }

  const declarationKinds = index.symbols
    .filter((symbol) => symbol.name === name && containsPosition(symbol.location.range, position))
    .map((symbol) => symbol.kind);
  if (declarationKinds.length > 0) {
    return targets.filter((target) => declarationKinds.includes(target.kind));
  }

  return targets;
}

function locationKey(location: Location): string {
  const range = location.range;
  return [
    location.uri,
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

export function uniqueLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = locationKey(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
