import type {
  Connection,
  Location,
  ReferenceParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  Range,
  ReferenceContext,
  ReferenceEntry,
  SymbolEntry,
  SymbolKind,
} from '@unity-shader-nav/shared';
import {
  resolveReferenceTargets,
  resolveReferenceTargetsForName,
  resolveReferenceTargetsForMemberReference,
  wordAt,
  type ReferenceTarget,
} from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';

function samePosition(a: Range['start'], b: Range['start']): boolean {
  return a.line === b.line && a.character === b.character;
}

function sameRange(a: Range, b: Range): boolean {
  return samePosition(a.start, b.start) && samePosition(a.end, b.end);
}

function sameTarget(a: ReferenceTarget, b: ReferenceTarget): boolean {
  return a.kind === b.kind && a.uri === b.uri && sameRange(a.range, b.range);
}

function isScopedTarget(target: ReferenceTarget): boolean {
  return (target.kind === 'localVariable' || target.kind === 'parameter') && !!target.scopeRange;
}

function isMemberTarget(target: ReferenceTarget): boolean {
  return target.kind === 'structMember' && !!target.parentType;
}

function isGlobalKindAwareTarget(target: ReferenceTarget): boolean {
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

function isReferenceContextCompatible(target: ReferenceTarget, reference: ReferenceEntry): boolean {
  return compatibleReferenceContexts(target.kind).includes(reference.context);
}

function isSymbolKindCompatible(target: ReferenceTarget, symbol: SymbolEntry): boolean {
  return symbol.kind === target.kind;
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

function uniqueLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = locationKey(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function registerReferencesHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
    const resolveRequest = async (): Promise<Location[] | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      const word = wordAt(document.getText(), params.position);
      if (!word) return null;

      const idx = workspace.store?.get(params.textDocument.uri);
      const targets = idx
        ? resolveReferenceTargets(idx, document.getText(), params.position, workspace.global)
        : [];
      const scopedTargets = targets.filter(isScopedTarget);
      const memberTargets = targets.filter(isMemberTarget);
      const narrowedTargets = [...scopedTargets, ...memberTargets];
      const globalKindAwareTargets = narrowedTargets.length === 0
        ? targets.filter(isGlobalKindAwareTarget)
        : [];
      const queryName = targets[0]?.name ?? word.text;
      const includePackages = workspace.settings.findReferences.includePackages;
      const symbolsAsReferences = params.context.includeDeclaration
        ? workspace.global
          .lookup(queryName)
          .filter((symbol) => includePackages || !workspace.isInPackages(symbol.location.uri))
          .filter((symbol) => (
            narrowedTargets.length === 0
            || narrowedTargets.some((target) => sameTarget(target, {
              name: symbol.name,
              kind: symbol.kind,
              uri: symbol.location.uri,
              range: symbol.location.range,
              scopeRange: symbol.scopeRange,
              parentType: symbol.parentType,
            }))
          ))
          .filter((symbol) => (
            globalKindAwareTargets.length === 0
            || globalKindAwareTargets.some((target) => isSymbolKindCompatible(target, symbol))
          ))
          .map((symbol) => ({
            uri: symbol.location.uri,
            range: symbol.location.range,
          }))
        : [];

      const references = workspace.globalRefs
        .lookup(queryName)
        .filter((reference) => includePackages || !workspace.isInPackages(reference.location.uri))
        .filter((reference) => {
          if (narrowedTargets.length === 0 && globalKindAwareTargets.length === 0) return true;
          const activeTargets = narrowedTargets.length > 0 ? narrowedTargets : globalKindAwareTargets;

          if (
            globalKindAwareTargets.length > 0 &&
            !globalKindAwareTargets.some((target) => isReferenceContextCompatible(target, reference))
          ) {
            return false;
          }

          const candidateIndex = workspace.store?.get(reference.location.uri);
          if (!candidateIndex) return false;

          const candidateTargets = reference.context === 'member'
            ? resolveReferenceTargetsForMemberReference(candidateIndex, reference, workspace.global)
            : reference.context !== 'include'
              ? resolveReferenceTargetsForName(
                candidateIndex,
                reference.name,
                reference.location.range.start,
                workspace.global,
              )
              : [];

          return candidateTargets.some((candidate) =>
            activeTargets.some((target) =>
              narrowedTargets.length > 0
                ? sameTarget(candidate, target)
                : candidate.kind === target.kind && isReferenceContextCompatible(target, reference),
            ),
          );
        })
        .map((reference) => ({
          uri: reference.location.uri,
          range: reference.location.range,
        }));

      return uniqueLocations([...symbolsAsReferences, ...references]);
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
