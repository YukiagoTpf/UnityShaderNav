import type {
  Connection,
  Location,
  ReferenceParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import type {
  FileIndex,
  Range,
  ReferenceContext,
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
import { resolveInclude } from '../include';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { scanIncludes } from '../parser/include/lineScanner';
import type { WorkspaceManager } from '../workspace';

function samePosition(a: Range['start'], b: Range['start']): boolean {
  return a.line === b.line && a.character === b.character;
}

function sameRange(a: Range, b: Range): boolean {
  return samePosition(a.start, b.start) && samePosition(a.end, b.end);
}

function containsPosition(range: Range, position: Range['start']): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

function includePathContainsPosition(range: Range, position: Range['start']): boolean {
  return position.line === range.start.line
    && position.character >= range.start.character
    && position.character <= range.end.character;
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

function isReferenceContextCompatible(target: ReferenceTarget, context: ReferenceContext): boolean {
  return compatibleReferenceContexts(target.kind).includes(context);
}

function isSymbolKindCompatible(target: ReferenceTarget, symbol: SymbolEntry): boolean {
  return symbol.kind === target.kind;
}

function narrowGlobalTargetsForOccurrence(
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

      const fullText = document.getText();
      const include = scanIncludes(fullText).find((candidate) =>
        includePathContainsPosition(candidate.pathRange, params.position),
      );
      if (include) {
        const resolved = await resolveInclude(
          include.path,
          params.textDocument.uri,
          workspace.includeCtx,
        );
        if (!resolved) return null;

        const targetUri = pathToFileURL(resolved.absolutePath).href;
        const includePackages = workspace.settings.findReferences.includePackages;
        const locations: Location[] = [];

        for (const uri of workspace.store.uris()) {
          const index = workspace.store.get(uri);
          if (!index) continue;

          for (const reference of index.references) {
            if (reference.context !== 'include') continue;
            if (!includePackages && workspace.isInPackages(reference.location.uri)) continue;

            const candidate = await resolveInclude(
              reference.name,
              reference.location.uri,
              workspace.includeCtx,
            );
            if (!candidate) continue;
            if (pathToFileURL(candidate.absolutePath).href !== targetUri) continue;

            locations.push({
              uri: reference.location.uri,
              range: reference.location.range,
            });
          }
        }

        return uniqueLocations(locations);
      }

      const word = wordAt(fullText, params.position);
      if (!word) return null;

      const idx = workspace.store?.get(params.textDocument.uri);
      const targets = idx
        ? resolveReferenceTargets(idx, fullText, params.position, workspace.global)
        : [];
      const scopedTargets = targets.filter(isScopedTarget);
      const memberTargets = targets.filter(isMemberTarget);
      const narrowedTargets = [...scopedTargets, ...memberTargets];
      const queryName = targets[0]?.name ?? word.text;
      const globalKindAwareTargets = narrowedTargets.length === 0
        ? narrowGlobalTargetsForOccurrence(
          targets.filter(isGlobalKindAwareTarget),
          idx,
          queryName,
          params.position,
        )
        : [];
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
            !globalKindAwareTargets.some((target) =>
              isReferenceContextCompatible(target, reference.context),
            )
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
                : candidate.kind === target.kind &&
                  isReferenceContextCompatible(target, reference.context),
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
