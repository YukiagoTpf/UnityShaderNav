import type { Location } from 'vscode-languageserver/node';
import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolReader } from './globalIndex';
import type { GlobalReferenceReader } from './globalReferences';
import type { IndexStoreReader } from './indexStore';
import type { IncludeChain } from '../include';
import type { CursorTarget } from './cursorTarget';
import { resolveDefinitionSymbols, type ResolutionOptions } from './symbolResolver';
import { resolveMemberSymbols } from './chainLookup';
import {
  resolveReferenceTargetsForCursor,
  resolveReferenceTargetsForName,
  resolveReferenceTargetsForMemberReference,
  type ReferenceTarget,
} from './referenceResolver';
import {
  isGlobalKindAwareTarget,
  isMemberTarget,
  isReferenceContextCompatible,
  isScopedTarget,
  narrowGlobalTargetsForOccurrence,
  sameTarget,
  symbolToTarget,
  uniqueLocations,
} from './referenceMatching';

export interface ResolverContext {
  index: FileIndex;
  global: GlobalSymbolReader | null;
  position: Position;
  options?: ResolutionOptions;
}

export function resolveDefinition(target: CursorTarget, ctx: ResolverContext): SymbolEntry[] {
  switch (target.kind) {
    case 'member':
      return resolveMemberSymbols(
        ctx.index,
        ctx.global,
        target.receiver.text,
        target.member.text,
        ctx.position,
        ctx.options,
      );
    case 'symbol':
      return resolveDefinitionSymbols(ctx.index, target.word.text, ctx.position, ctx.global, ctx.options);
    default:
      return []; // include | none
  }
}

export interface ReferenceCollectionContext {
  index: FileIndex | undefined;
  position: Position;
  global: GlobalSymbolReader;
  globalRefs: GlobalReferenceReader;
  store: IndexStoreReader;
  includeChain: IncludeChain;
  isInPackages: (uri: string) => boolean;
  includePackages: boolean;
  includeDeclaration: boolean;
}

export async function findReferences(
  target: CursorTarget,
  ctx: ReferenceCollectionContext,
): Promise<Location[]> {
  const idx = ctx.index;
  const word = target.kind === 'member'
    ? target.member
    : target.kind === 'symbol'
      ? target.word
      : undefined;

  const visibleByUri = new Map<string, Promise<ReadonlySet<string>>>();
  const visibleForUri = (uri: string): Promise<ReadonlySet<string>> => {
    const existing = visibleByUri.get(uri);
    if (existing) return existing;

    const next = ctx.includeChain.visibleUriKeys(uri);
    visibleByUri.set(uri, next);
    return next;
  };
  const visibleUriKeys = idx ? await visibleForUri(idx.uri) : undefined;
  const resolutionOptions: ResolutionOptions | undefined = visibleUriKeys ? { visibleUriKeys } : undefined;
  const targets = idx
    ? resolveReferenceTargetsForCursor(idx, target, ctx.position, ctx.global, resolutionOptions)
    : [];
  const scopedTargets = targets.filter(isScopedTarget);
  const memberTargets = targets.filter(isMemberTarget);
  const narrowedTargets = [...scopedTargets, ...memberTargets];
  const queryName = targets[0]?.name ?? word?.text ?? '';
  const globalKindAwareTargets = narrowedTargets.length === 0
    ? narrowGlobalTargetsForOccurrence(
      targets.filter(isGlobalKindAwareTarget),
      idx,
      queryName,
      ctx.position,
    )
    : [];
  const activeTargets = narrowedTargets.length > 0 ? narrowedTargets : globalKindAwareTargets;
  const includePackages = ctx.includePackages;
  const symbolsAsReferences = ctx.includeDeclaration
    ? ctx.global
      .lookup(queryName)
      .filter((symbol) => includePackages || !ctx.isInPackages(symbol.location.uri))
      .filter((symbol) =>
        activeTargets.length === 0 ||
        activeTargets.some((target) => sameTarget(target, symbolToTarget(symbol))))
      .map((symbol) => ({
        uri: symbol.location.uri,
        range: symbol.location.range,
      }))
    : [];

  const references: Location[] = [];
  for (const reference of ctx.globalRefs.lookup(queryName)) {
    if (!includePackages && ctx.isInPackages(reference.location.uri)) continue;

    if (activeTargets.length === 0) {
      references.push({ uri: reference.location.uri, range: reference.location.range });
      continue;
    }

    if (
      globalKindAwareTargets.length > 0 &&
      !globalKindAwareTargets.some((target) =>
        isReferenceContextCompatible(target, reference.context),
      )
    ) {
      continue;
    }

    const candidateIndex = ctx.store?.get(reference.location.uri);
    if (!candidateIndex) continue;

    const candidateVisibleUriKeys = await visibleForUri(reference.location.uri);
    const candidateResolutionOptions = { visibleUriKeys: candidateVisibleUriKeys };
    const candidateTargets = reference.context === 'member'
      ? resolveReferenceTargetsForMemberReference(
        candidateIndex,
        reference,
        ctx.global,
        candidateResolutionOptions,
      )
      : reference.context !== 'include'
        ? resolveReferenceTargetsForName(
          candidateIndex,
          reference.name,
          reference.location.range.start,
          ctx.global,
          candidateResolutionOptions,
        )
        : [];

    if (
      candidateTargets.some((candidate) =>
        activeTargets.some((target) => sameTarget(candidate, target)),
      )
    ) {
      references.push({ uri: reference.location.uri, range: reference.location.range });
    }
  }

  return uniqueLocations([...symbolsAsReferences, ...references]);
}

export interface HighlightCollectionContext {
  index: FileIndex;
  position: Position;
  global: GlobalSymbolReader;
  options?: ResolutionOptions;
}

function isSimpleIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isVariableReceiverTarget(target: ReferenceTarget): boolean {
  return target.kind === 'localVariable' || target.kind === 'parameter' || target.kind === 'variable';
}

function receiverTargets(
  index: FileIndex,
  receiver: string,
  position: Position,
  global: GlobalSymbolReader | null,
  options: ResolutionOptions | undefined,
): ReferenceTarget[] {
  if (!isSimpleIdentifier(receiver)) return [];
  return resolveReferenceTargetsForName(index, receiver, position, global, options)
    .filter(isVariableReceiverTarget);
}

// documentHighlight member fallback: when a member access resolves to no
// declared target, highlight every member reference in the file that shares the
// same resolved receiver variable. Kept single-file and un-deduped to match the
// handler's historical early-return shape.
function sameReceiverMemberLocations(
  index: FileIndex,
  memberName: string,
  receiverName: string,
  receiverPosition: Position,
  global: GlobalSymbolReader | null,
  options: ResolutionOptions | undefined,
): Location[] {
  const activeReceiverTargets = receiverTargets(index, receiverName, receiverPosition, global, options);
  if (activeReceiverTargets.length === 0) return [];

  const locations: Location[] = [];
  for (const reference of index.references) {
    if (
      reference.name !== memberName ||
      reference.context !== 'member' ||
      !reference.receiver ||
      !isSimpleIdentifier(reference.receiver)
    ) {
      continue;
    }

    const candidateReceiverTargets = receiverTargets(
      index,
      reference.receiver,
      reference.location.range.start,
      global,
      options,
    );
    if (
      candidateReceiverTargets.some((candidate) =>
        activeReceiverTargets.some((target) => sameTarget(candidate, target)),
      )
    ) {
      locations.push({ uri: reference.location.uri, range: reference.location.range });
    }
  }

  return locations;
}

/**
 * Single-file highlight search — the document-scoped sibling of
 * {@link findReferences}. Resolves the cursor target, narrows
 * scoped/member/global candidates, then collects the declaration + reference
 * occurrences in the active file, deduped. Returns plain `Location[]`; the
 * handler projects them to `DocumentHighlight` at the edge.
 */
export function findHighlights(target: CursorTarget, ctx: HighlightCollectionContext): Location[] {
  const { index, position, global, options } = ctx;

  let targets: ReferenceTarget[];
  if (target.kind === 'member') {
    targets = resolveMemberSymbols(
      index,
      global,
      target.receiver.text,
      target.member.text,
      position,
      options,
    ).map(symbolToTarget);
    if (targets.length === 0) {
      // Member fallback returns early, before the declaration/reference tail and
      // without uniqueLocations — preserving documentHighlight's historical shape.
      return sameReceiverMemberLocations(
        index,
        target.member.text,
        target.receiver.text,
        target.receiver.range.start,
        global,
        options,
      );
    }
  } else if (target.kind === 'symbol') {
    // Text-free equivalent of resolveReferenceTargets(index, fullText, position):
    // a `symbol` cursor target has no receiver, so that function's member branch
    // is dead and it falls through to resolveReferenceTargetsForName by word text.
    targets = resolveReferenceTargetsForName(index, target.word.text, position, global, options);
  } else {
    return [];
  }

  const queryName = targets[0]?.name ?? (target.kind === 'member' ? target.member.text : target.word.text);
  const scopedTargets = targets.filter(isScopedTarget);
  const memberTargets = targets.filter(isMemberTarget);
  const narrowedTargets = [...scopedTargets, ...memberTargets];
  const globalKindAwareTargets = narrowedTargets.length === 0
    ? narrowGlobalTargetsForOccurrence(
      targets.filter(isGlobalKindAwareTarget),
      index,
      queryName,
      position,
    )
    : [];
  const activeTargets = narrowedTargets.length > 0 ? narrowedTargets : globalKindAwareTargets;

  const declarations: Location[] = global
    .lookup(queryName)
    .filter((symbol) => symbol.location.uri === index.uri)
    .filter((symbol) =>
      activeTargets.length === 0 ||
      activeTargets.some((candidate) => sameTarget(candidate, symbolToTarget(symbol))),
    )
    .map((symbol) => ({ uri: symbol.location.uri, range: symbol.location.range }));

  const references: Location[] = [];
  for (const reference of index.references) {
    if (reference.name !== queryName) continue;
    if (reference.context === 'include') continue;

    if (activeTargets.length === 0) {
      references.push({ uri: reference.location.uri, range: reference.location.range });
      continue;
    }

    if (
      globalKindAwareTargets.length > 0 &&
      !globalKindAwareTargets.some((candidate) =>
        isReferenceContextCompatible(candidate, reference.context),
      )
    ) {
      continue;
    }

    const candidateTargets = reference.context === 'member'
      ? resolveReferenceTargetsForMemberReference(index, reference, global, options)
      : resolveReferenceTargetsForName(
        index,
        reference.name,
        reference.location.range.start,
        global,
        options,
      );

    if (
      candidateTargets.some((candidate) =>
        activeTargets.some((target) => sameTarget(candidate, target)),
      )
    ) {
      references.push({ uri: reference.location.uri, range: reference.location.range });
    }
  }

  return uniqueLocations([...declarations, ...references]);
}
