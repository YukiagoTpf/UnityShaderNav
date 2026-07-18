import type {
  FileIndex,
  FunctionSymbolEntry,
  Position,
  SymbolEntry,
} from '@unity-shader-nav/shared';
import type { CancellationToken } from 'vscode-languageserver/node';
import type { IncludeChain } from '../include';
import {
  inferReceiverTypeForCompletion,
  selectGlobalSymbolEntries,
  selectSymbolEntryGroups,
  type GlobalSymbolReader,
  type IndexStoreReader,
} from '../index';
import { locationKey } from '../sourceLocation';
import { uriKey } from '../uriKey';
import {
  awaitWithRequestCancellation,
  cooperativeRequestCheckpoint,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import {
  collectBuiltinFunctionSuggestions,
  collectBuiltinSuggestions,
} from './builtins';
import type { SuggestionContext } from './context';
import type { ShaderSuggestion } from './types';

export type SuggestionCandidateQuery =
  | {
    readonly kind: 'completion';
    readonly context: SuggestionContext;
  }
  | {
    readonly kind: 'member';
    readonly receiver: string;
    readonly prefix: string;
  }
  | {
    readonly kind: 'signature';
    readonly context: SuggestionContext;
    readonly name: string;
    readonly activeParameter: number;
  };

export interface SuggestionCandidateInput {
  readonly uri: string;
  readonly position: Position;
  readonly query: SuggestionCandidateQuery;
  readonly cancellation?: CancellationToken;
}

export interface SuggestionCandidateSelection {
  readonly suggestions: readonly ShaderSuggestion[];
  /** Index into suggestions for signature queries. */
  readonly activeSuggestion?: number;
}

/**
 * One query-facing interface for project visibility, ranking, member inference,
 * overload selection, dedupe, and project-over-builtin precedence.
 */
export interface SuggestionCandidateSelector {
  select(
    input: SuggestionCandidateInput,
  ): Promise<SuggestionCandidateSelection | undefined>;
}

export interface SuggestionIndexReadView {
  readonly store: IndexStoreReader;
  readonly global: GlobalSymbolReader;
}

export function createSuggestionCandidateSelector(
  index: SuggestionIndexReadView,
  includeChain: IncludeChain,
): SuggestionCandidateSelector {
  return new PublishedSuggestionCandidateSelector(index, includeChain);
}

class PublishedSuggestionCandidateSelector implements SuggestionCandidateSelector {
  constructor(
    private readonly index: SuggestionIndexReadView,
    private readonly includeChain: IncludeChain,
  ) {}

  async select(
    input: SuggestionCandidateInput,
  ): Promise<SuggestionCandidateSelection | undefined> {
    throwIfRequestCancelled(input.cancellation);
    const current = this.index.store.get(input.uri);
    if (!current) return undefined;

    switch (input.query.kind) {
      case 'completion':
        return this.selectCompletion(
          current,
          input.position,
          input.query.context,
          input.cancellation,
        );
      case 'member':
        return this.selectMembers(
          current,
          input.position,
          input.query.receiver,
          input.query.prefix,
          input.cancellation,
        );
      case 'signature':
        return this.selectSignatures(
          current,
          input.position,
          input.query.context,
          input.query.name,
          input.query.activeParameter,
          input.cancellation,
        );
    }
  }

  private async selectCompletion(
    current: FileIndex,
    position: Position,
    context: SuggestionContext,
    cancellation?: CancellationToken,
  ): Promise<SuggestionCandidateSelection> {
    const projectSuggestions = context.kind === 'hlslCode'
      ? await collectVisibleProjectSuggestions({
        index: current,
        store: this.index.store,
        global: this.index.global,
        visibleUriKeys: await this.visibleUriKeys(current.uri, cancellation),
        position,
      }, context.prefix.text, cancellation)
      : [];

    return {
      suggestions: mergeProjectAndBuiltinSuggestions(
        projectSuggestions,
        collectBuiltinSuggestions(context),
      ),
    };
  }

  private async selectMembers(
    current: FileIndex,
    position: Position,
    receiver: string,
    prefix: string,
    cancellation?: CancellationToken,
  ): Promise<SuggestionCandidateSelection> {
    const visibleUriKeys = await this.visibleUriKeys(current.uri, cancellation);
    return {
      suggestions: await collectMemberSuggestions(
        current,
        this.index.store,
        this.index.global,
        visibleUriKeys,
        receiver,
        prefix,
        position,
        cancellation,
      ),
    };
  }

  private async selectSignatures(
    current: FileIndex,
    position: Position,
    context: SuggestionContext,
    name: string,
    activeParameter: number,
    cancellation?: CancellationToken,
  ): Promise<SuggestionCandidateSelection> {
    const projectSuggestions = await collectVisibleProjectFunctionSuggestions({
      index: current,
      store: this.index.store,
      global: this.index.global,
      visibleUriKeys: await this.visibleUriKeys(current.uri, cancellation),
      position,
      name,
    }, cancellation);
    const suggestions = projectSuggestions.length > 0
      ? projectSuggestions
      : collectBuiltinFunctionSuggestions(name, context);

    return {
      suggestions,
      ...(suggestions.length > 0
        ? { activeSuggestion: compatibleSignatureIndex(suggestions, activeParameter) }
        : {}),
    };
  }

  private visibleUriKeys(
    uri: string,
    cancellation?: CancellationToken,
  ): Promise<ReadonlySet<string>> {
    return awaitWithRequestCancellation(
      this.includeChain.visibleUriKeys(uri),
      cancellation,
    );
  }
}

interface CollectProjectSuggestionsInput {
  readonly index: FileIndex;
  readonly store: IndexStoreReader;
  readonly global: GlobalSymbolReader;
  readonly visibleUriKeys: ReadonlySet<string>;
  readonly position: Position;
}

function isGlobalSuggestion(symbol: SymbolEntry): boolean {
  return symbol.kind !== 'parameter'
    && symbol.kind !== 'localVariable'
    && symbol.kind !== 'structMember';
}

function functionSignatureKey(symbol: FunctionSymbolEntry): string {
  return symbol.parameters.map((parameter) => parameter.type).join(',');
}

function symbolLocationKey(symbol: SymbolEntry): string {
  return locationKey(uriKey(symbol.location.uri), symbol.location.range);
}

function dedupeKey(symbol: SymbolEntry): string {
  if (symbol.kind === 'function') {
    return [
      symbol.name,
      symbol.kind,
      functionSignatureKey(symbol as FunctionSymbolEntry),
      symbolLocationKey(symbol),
    ].join('|');
  }
  return [symbol.name, symbol.kind, symbol.parentType ?? ''].join('|');
}

function symbolToSuggestion(symbol: SymbolEntry, sourceRank: number): ShaderSuggestion {
  const suggestion: ShaderSuggestion = {
    name: symbol.name,
    kind: symbol.kind,
    source: 'project',
    sortText: `${sourceRank}_${symbol.name}`,
    declaredType: symbol.declaredType,
    parentType: symbol.parentType,
  };
  if (symbol.kind === 'function') {
    const fn = symbol as FunctionSymbolEntry;
    suggestion.returnType = fn.returnType;
    suggestion.parameters = fn.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
    }));
  }
  return suggestion;
}

async function collectVisibleProjectSuggestions(
  input: CollectProjectSuggestionsInput,
  prefix: string,
  cancellation?: CancellationToken,
): Promise<ShaderSuggestion[]> {
  const matching = await collectMatchingCompletionSymbols(
    input,
    prefix,
    cancellation,
  );
  const groups = selectSymbolEntryGroups(
    matching.index,
    input.position,
    matching.visible,
    { visibleUriKeys: input.visibleUriKeys },
  );
  const ordered: Array<{ symbol: SymbolEntry; rank: number }> = [
    ...groups.scoped.map((symbol) => ({ symbol, rank: 0 })),
    ...groups.currentGlobals
      .filter(isGlobalSuggestion)
      .map((symbol) => ({ symbol, rank: 1 })),
    ...groups.visibleGlobals
      .filter(isGlobalSuggestion)
      .map((symbol) => ({ symbol, rank: 2 })),
  ];

  const seen = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  let materialized = 0;
  for (const candidate of ordered) {
    const checkpoint = cooperativeRequestCheckpoint(++materialized, cancellation);
    if (checkpoint) await checkpoint;
    const key = dedupeKey(candidate.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(symbolToSuggestion(candidate.symbol, candidate.rank));
  }
  throwIfRequestCancelled(cancellation);
  return suggestions;
}

async function collectMatchingCompletionSymbols(
  input: CollectProjectSuggestionsInput,
  prefix: string,
  cancellation?: CancellationToken,
): Promise<{
  readonly index: FileIndex;
  readonly visible: readonly SymbolEntry[];
}> {
  const current: SymbolEntry[] = [];
  const visible: SymbolEntry[] = [];
  let scanned = 0;

  for (const symbol of input.index.symbols) {
    if (symbol.name.startsWith(prefix)) current.push(symbol);
    const checkpoint = cooperativeRequestCheckpoint(++scanned, cancellation);
    if (checkpoint) await checkpoint;
  }
  for (const symbol of visibleProjectSymbols(input)) {
    if (symbol.name.startsWith(prefix)) visible.push(symbol);
    const checkpoint = cooperativeRequestCheckpoint(++scanned, cancellation);
    if (checkpoint) await checkpoint;
  }
  throwIfRequestCancelled(cancellation);

  return {
    index: { ...input.index, symbols: current },
    visible,
  };
}

function* visibleProjectSymbols(
  input: CollectProjectSuggestionsInput,
): IterableIterator<SymbolEntry> {
  for (const visibleUri of input.store.uris()) {
    const visibleKey = uriKey(visibleUri);
    if (
      visibleKey === uriKey(input.index.uri)
      || !input.visibleUriKeys.has(visibleKey)
    ) continue;
    const visibleIndex = input.store.get(visibleUri);
    if (!visibleIndex) continue;
    yield* visibleIndex.symbols;
  }
}

async function collectVisibleProjectFunctionSuggestions(
  input: CollectProjectSuggestionsInput & { readonly name: string },
  cancellation?: CancellationToken,
): Promise<ShaderSuggestion[]> {
  const ordered = selectGlobalSymbolEntries(
    input.index,
    input.name,
    input.global,
    { visibleUriKeys: input.visibleUriKeys },
  ).filter((symbol): symbol is FunctionSymbolEntry => symbol.kind === 'function')
    .map((symbol) => ({
      symbol,
      rank: uriKey(symbol.location.uri) === uriKey(input.index.uri) ? 1 : 2,
    }));

  const seen = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  let processed = 0;
  for (const candidate of ordered) {
    const checkpoint = cooperativeRequestCheckpoint(++processed, cancellation);
    if (checkpoint) await checkpoint;
    const key = symbolLocationKey(candidate.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(symbolToSuggestion(candidate.symbol, candidate.rank));
  }
  return suggestions;
}

async function collectMemberSuggestions(
  index: FileIndex,
  store: IndexStoreReader,
  global: GlobalSymbolReader | null | undefined,
  visibleUriKeys: ReadonlySet<string>,
  receiver: string,
  memberPrefix: string,
  position: Position,
  cancellation?: CancellationToken,
): Promise<ShaderSuggestion[]> {
  const receiverType = inferReceiverTypeForCompletion(
    index,
    global,
    receiver,
    position,
    { visibleUriKeys },
  );
  if (!receiverType) return [];

  const indexes = [index];
  for (const uri of store.uris()) {
    const key = uriKey(uri);
    if (key === uriKey(index.uri) || !visibleUriKeys.has(key)) continue;
    const visibleIndex = store.get(uri);
    if (visibleIndex) indexes.push(visibleIndex);
  }

  const seen = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  let processed = 0;
  for (const candidateIndex of indexes) {
    const rank = uriKey(candidateIndex.uri) === uriKey(index.uri) ? 1 : 2;
    for (const symbol of candidateIndex.symbols) {
      const checkpoint = cooperativeRequestCheckpoint(++processed, cancellation);
      if (checkpoint) await checkpoint;
      if (
        symbol.kind !== 'structMember'
        || symbol.parentType !== receiverType
        || !symbol.name.startsWith(memberPrefix)
      ) {
        continue;
      }
      const key = [symbol.name, symbol.parentType ?? ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(symbolToSuggestion(symbol, rank));
    }
  }
  return suggestions;
}

function compatibleSignatureIndex(
  suggestions: readonly ShaderSuggestion[],
  activeParameter: number,
): number {
  const compatible = suggestions.findIndex((suggestion) => (
    (suggestion.parameters?.length ?? 0) > activeParameter
  ));
  return compatible >= 0 ? compatible : 0;
}

function mergeProjectAndBuiltinSuggestions(
  projectSuggestions: readonly ShaderSuggestion[],
  builtinSuggestions: readonly ShaderSuggestion[],
): ShaderSuggestion[] {
  const projectNames = new Set(projectSuggestions.map((suggestion) => suggestion.name));
  const seenBuiltinNames = new Set<string>();
  const visibleBuiltins: ShaderSuggestion[] = [];
  for (const suggestion of builtinSuggestions) {
    if (projectNames.has(suggestion.name) || seenBuiltinNames.has(suggestion.name)) continue;
    seenBuiltinNames.add(suggestion.name);
    visibleBuiltins.push(suggestion);
  }
  return [...projectSuggestions, ...visibleBuiltins];
}
