import type { Location } from 'vscode-languageserver/node';
import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex } from './globalIndex';
import type { GlobalReferenceIndex } from './globalReferences';
import type { IndexStore } from './indexStore';
import type { IncludeContext } from '../include';
import type { CursorTarget } from './cursorTarget';
import { resolveDefinitionSymbols, type ResolutionOptions } from './symbolResolver';
import { resolveMemberSymbols } from './chainLookup';
import {
  resolveReferenceTargetsForCursor,
  resolveReferenceTargetsForName,
  resolveReferenceTargetsForMemberReference,
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
import { collectVisibleUriKeys } from './visibility';

export interface ResolverContext {
  index: FileIndex;
  global: GlobalSymbolIndex | null;
  position: Position;
  options?: ResolutionOptions;
}

export function resolveTarget(target: CursorTarget, ctx: ResolverContext): SymbolEntry[] {
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
  global: GlobalSymbolIndex;
  globalRefs: GlobalReferenceIndex;
  store: IndexStore;
  includeCtx: IncludeContext;
  isInPackages: (uri: string) => boolean;
  includePackages: boolean;
  includeDeclaration: boolean;
}

export async function collectReferences(
  target: CursorTarget,
  ctx: ReferenceCollectionContext,
): Promise<Location[]> {
  const idx = ctx.index;
  const word = target.kind === 'member'
    ? target.member
    : target.kind === 'symbol'
      ? target.word
      : undefined;

  const visibleByUri = new Map<string, Promise<Set<string>>>();
  const visibleForUri = (uri: string): Promise<Set<string>> => {
    const existing = visibleByUri.get(uri);
    if (existing) return existing;

    const next = collectVisibleUriKeys(ctx.store, ctx.includeCtx, uri);
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
