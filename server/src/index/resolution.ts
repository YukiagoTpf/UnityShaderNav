import type { CancellationToken, Location } from 'vscode-languageserver/node';
import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import type { VariantContext } from '@unity-shader-nav/shared';
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
  symbolToTarget,
  type ReferenceTarget,
} from './referenceResolver';
import {
  isGlobalKindAwareTarget,
  isMemberTarget,
  isReferenceContextCompatible,
  isScopedTarget,
  narrowGlobalTargetsForOccurrence,
  sameMethodOverload,
  sameTarget,
  uniqueLocations,
} from './referenceMatching';
import { selectGlobalSymbolEntries } from './symbolSelection';
import { uriKey } from '../uriKey';
import {
  awaitWithRequestCancellation,
  cooperativeRequestCheckpoint,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import { isLineActive } from '../parser/preproc/branchActivity';

export interface ResolverContext {
  index: FileIndex;
  global: GlobalSymbolReader | null;
  position: Position;
  options?: ResolutionOptions;
  variantContext?: VariantContext;
  getText?: (uri: string) => string | undefined;
  isShaderLab?: boolean;
}

export function resolveDefinition(target: CursorTarget, ctx: ResolverContext): SymbolEntry[] {
  let candidates: SymbolEntry[];
  switch (target.kind) {
    case 'member':
      candidates = resolveMemberSymbols(
        ctx.index,
        ctx.global,
        target.receiver.text,
        target.member.text,
        ctx.position,
        ctx.options,
      );
      break;
    case 'symbol':
      candidates = resolveDefinitionSymbols(
        ctx.index,
        target.word.text,
        ctx.position,
        ctx.global,
        ctx.options,
      );
      break;
    default:
      return []; // include | none
  }
  return filterByVariantContext(candidates, ctx);
}

function filterByVariantContext(
  candidates: SymbolEntry[],
  ctx: {
    variantContext?: VariantContext;
    getText?: (uri: string) => string | undefined;
    isShaderLab?: boolean;
  },
): SymbolEntry[] {
  if (!ctx.variantContext || !ctx.getText) return candidates;
  const active: SymbolEntry[] = [];
  for (const c of candidates) {
    const text = ctx.getText(c.location.uri);
    if (!text) {
      active.push(c);
      continue;
    }
    if (isLineActive(text, c.location.range.start.line, ctx.variantContext, ctx.isShaderLab)) {
      active.push(c);
    }
  }
  return active.length > 0 ? active : candidates;
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
  cancellation?: CancellationToken;
  variantContext?: VariantContext;
  getText?: (uri: string) => string | undefined;
  isShaderLab?: boolean;
}

export interface ActiveReferenceTargetSelection {
  readonly queryName: string;
  readonly targets: readonly ReferenceTarget[];
}

function uniqueReferenceTargets(targets: readonly ReferenceTarget[]): ReferenceTarget[] {
  const unique: ReferenceTarget[] = [];
  for (const target of targets) {
    if (!unique.some((candidate) => (
      sameTarget(candidate, target) || sameMethodOverload(candidate, target)
    ))) unique.push(target);
  }
  return unique;
}

type VisibleUriLookup = (uri: string) => Promise<ReadonlySet<string>>;

/**
 * Resolve the declaration identity selected by one cursor occurrence. This is
 * the shared narrowing policy for References and Rename: scoped declarations
 * win, then typed members, then global candidates compatible with the
 * occurrence's lexical role.
 */
export function selectActiveReferenceTargets(
  target: CursorTarget,
  index: FileIndex,
  position: Position,
  global: GlobalSymbolReader,
  options?: ResolutionOptions,
): ActiveReferenceTargetSelection {
  const resolved = resolveReferenceTargetsForCursor(
    index,
    target,
    position,
    global,
    options,
  );
  const scopedTargets = resolved.filter(isScopedTarget);
  const memberTargets = resolved.filter(isMemberTarget);
  const narrowedTargets = uniqueReferenceTargets([...scopedTargets, ...memberTargets]);
  const word = target.kind === 'member'
    ? target.member
    : target.kind === 'symbol'
      ? target.word
      : undefined;
  const queryName = resolved[0]?.name ?? word?.text ?? '';
  const globalKindAwareTargets = narrowedTargets.length === 0
    ? narrowGlobalTargetsForOccurrence(
      resolved.filter(isGlobalKindAwareTarget),
      index,
      queryName,
      position,
    )
    : [];

  return {
    queryName,
    targets: narrowedTargets.length > 0 ? narrowedTargets : globalKindAwareTargets,
  };
}

export async function findReferences(
  target: CursorTarget,
  ctx: ReferenceCollectionContext,
): Promise<Location[]> {
  throwIfRequestCancelled(ctx.cancellation);
  const idx = ctx.index;
  const word = target.kind === 'member'
    ? target.member
    : target.kind === 'symbol'
      ? target.word
      : undefined;

  const visibleForUri = createVisibleUriLookup(ctx);
  const visibleUriKeys = idx ? await visibleForUri(idx.uri) : undefined;
  const resolutionOptions: ResolutionOptions | undefined = visibleUriKeys ? { visibleUriKeys } : undefined;
  const selection = idx
    ? selectActiveReferenceTargets(
      target,
      idx,
      ctx.position,
      ctx.global,
      resolutionOptions,
    )
    : { queryName: word?.text ?? '', targets: [] };
  const allLocations = await collectReferencesForTargets(
    selection.queryName,
    selection.targets,
    ctx,
    visibleForUri,
  );
  return filterLocationsByVariantContext(allLocations, ctx);
}

/**
 * Collect references for one already-proven declaration. Rename uses this
 * fail-closed path so a later target-selection miss cannot fall back to every
 * occurrence that merely shares the same spelling.
 */
export async function findReferencesForTarget(
  target: ReferenceTarget,
  ctx: ReferenceCollectionContext,
): Promise<Location[]> {
  throwIfRequestCancelled(ctx.cancellation);
  return collectReferencesForTargets(
    target.name,
    [target],
    ctx,
    createVisibleUriLookup(ctx),
  );
}

function createVisibleUriLookup(ctx: ReferenceCollectionContext): VisibleUriLookup {
  const visibleByUri = new Map<string, Promise<ReadonlySet<string>>>();
  return (uri: string): Promise<ReadonlySet<string>> => {
    const key = uriKey(uri);
    const existing = visibleByUri.get(key);
    const operation = existing ?? ctx.includeChain.visibleUriKeys(uri);
    if (!existing) visibleByUri.set(key, operation);
    return awaitWithRequestCancellation(operation, ctx.cancellation);
  };
}

async function collectReferencesForTargets(
  queryName: string,
  activeTargets: readonly ReferenceTarget[],
  ctx: ReferenceCollectionContext,
  visibleForUri: VisibleUriLookup,
): Promise<Location[]> {
  const concreteTargets = await expandMethodTargets(activeTargets, ctx, visibleForUri);
  const globalKindAwareTargets = concreteTargets.filter(isGlobalKindAwareTarget);
  const includePackages = ctx.includePackages;
  const symbolsAsReferences: Location[] = [];
  let processed = 0;
  if (ctx.includeDeclaration) {
    for (const symbol of ctx.global.lookup(queryName)) {
      const checkpoint = cooperativeRequestCheckpoint(++processed, ctx.cancellation);
      if (checkpoint) await checkpoint;
      if (!includePackages && ctx.isInPackages(symbol.location.uri)) continue;
      if (
        concreteTargets.length > 0
        && !concreteTargets.some((target) => sameTarget(target, symbolToTarget(symbol)))
      ) continue;
      symbolsAsReferences.push({
        uri: symbol.location.uri,
        range: symbol.location.range,
      });
    }
  }

  const references: Location[] = [];
  for (const reference of ctx.globalRefs.lookup(queryName)) {
    const checkpoint = cooperativeRequestCheckpoint(++processed, ctx.cancellation);
    if (checkpoint) await checkpoint;
    if (!includePackages && ctx.isInPackages(reference.location.uri)) continue;

    if (concreteTargets.length === 0) {
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
    const candidateTargets = reference.receiver
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
        concreteTargets.some((target) => sameTarget(candidate, target)),
      )
    ) {
      references.push({ uri: reference.location.uri, range: reference.location.range });
    }
  }

  throwIfRequestCancelled(ctx.cancellation);
  return uniqueLocations([...symbolsAsReferences, ...references]);
}

async function expandMethodTargets(
  targets: readonly ReferenceTarget[],
  ctx: ReferenceCollectionContext,
  visibleForUri: VisibleUriLookup,
): Promise<ReferenceTarget[]> {
  const expanded: ReferenceTarget[] = [];
  for (const target of targets) {
    if (!target.parentType || target.kind !== 'function' || !target.methodSignature) {
      expanded.push(target);
      continue;
    }
    const sourceIndex = ctx.index ?? ctx.store.get(target.uri);
    if (!sourceIndex) {
      expanded.push(target);
      continue;
    }
    const visibleUriKeys = await visibleForUri(ctx.index?.uri ?? target.uri);
    const candidates = selectGlobalSymbolEntries(
      sourceIndex,
      target.name,
      ctx.global,
      { visibleUriKeys },
    ).map(symbolToTarget).filter((candidate) => sameMethodOverload(candidate, target));
    expanded.push(...(candidates.length > 0 ? candidates : [target]));
  }
  return uniqueReferenceTargetsByLocation(expanded);
}

function uniqueReferenceTargetsByLocation(
  targets: readonly ReferenceTarget[],
): ReferenceTarget[] {
  const unique: ReferenceTarget[] = [];
  for (const target of targets) {
    if (!unique.some((candidate) => sameTarget(candidate, target))) unique.push(target);
  }
  return unique;
}

function filterLocationsByVariantContext(
  locations: Location[],
  ctx: {
    variantContext?: VariantContext;
    getText?: (uri: string) => string | undefined;
    isShaderLab?: boolean;
  },
): Location[] {
  if (!ctx.variantContext || !ctx.getText) return locations;
  const active: Location[] = [];
  for (const loc of locations) {
    const text = ctx.getText(loc.uri);
    if (!text) {
      active.push(loc);
      continue;
    }
    if (isLineActive(text, loc.range.start.line, ctx.variantContext, ctx.isShaderLab)) {
      active.push(loc);
    }
  }
  return active.length > 0 ? active : locations;
}

export interface HighlightCollectionContext {
  index: FileIndex;
  position: Position;
  global: GlobalSymbolReader;
  options?: ResolutionOptions;
  cancellation?: CancellationToken;
  variantContext?: VariantContext;
  getText?: (uri: string) => string | undefined;
  isShaderLab?: boolean;
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
  cancellation?: CancellationToken,
): Location[] {
  const activeReceiverTargets = receiverTargets(index, receiverName, receiverPosition, global, options);
  if (activeReceiverTargets.length === 0) return [];

  const locations: Location[] = [];
  for (const reference of index.references) {
    throwIfRequestCancelled(cancellation);
    if (
      reference.name !== memberName ||
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
  throwIfRequestCancelled(ctx.cancellation);
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
      return filterLocationsByVariantContext(
        sameReceiverMemberLocations(
          index,
          target.member.text,
          target.receiver.text,
          target.receiver.range.start,
          global,
          options,
          ctx.cancellation,
        ),
        ctx,
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
    .filter((symbol) => uriKey(symbol.location.uri) === uriKey(index.uri))
    .filter((symbol) =>
      activeTargets.length === 0 ||
      activeTargets.some((candidate) => sameTarget(candidate, symbolToTarget(symbol))),
    )
    .map((symbol) => ({ uri: symbol.location.uri, range: symbol.location.range }));

  const references: Location[] = [];
  for (const reference of index.references) {
    throwIfRequestCancelled(ctx.cancellation);
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

    const candidateTargets = reference.receiver
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

  throwIfRequestCancelled(ctx.cancellation);
  return filterLocationsByVariantContext(
    uniqueLocations([...declarations, ...references]),
    ctx,
  );
}
