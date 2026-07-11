import type {
  FileIndex,
  FunctionSymbolEntry,
  Position,
  SymbolEntry,
} from '@unity-shader-nav/shared';
import type { IncludeContext } from '../include';
import {
  collectVisibleUriKeys,
  inferReceiverTypeForCompletion,
  type GlobalSymbolReader,
  type IndexStoreReader,
} from '../index';
import { inRange, isBeforeOrAt } from '../index/positionGeometry';
import { uriKey } from '../uriKey';
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
  readonly global: GlobalSymbolReader | null | undefined;
}

export function createSuggestionCandidateSelector(
  index: SuggestionIndexReadView,
  includeContext: IncludeContext,
): SuggestionCandidateSelector {
  return new PublishedSuggestionCandidateSelector(index, includeContext);
}

class PublishedSuggestionCandidateSelector implements SuggestionCandidateSelector {
  constructor(
    private readonly index: SuggestionIndexReadView,
    private readonly includeContext: IncludeContext,
  ) {}

  async select(
    input: SuggestionCandidateInput,
  ): Promise<SuggestionCandidateSelection | undefined> {
    const current = this.index.store.get(input.uri);
    if (!current) return undefined;

    switch (input.query.kind) {
      case 'completion':
        return this.selectCompletion(current, input.position, input.query.context);
      case 'member':
        return this.selectMembers(
          current,
          input.position,
          input.query.receiver,
          input.query.prefix,
        );
      case 'signature':
        return this.selectSignatures(
          current,
          input.position,
          input.query.context,
          input.query.name,
          input.query.activeParameter,
        );
    }
  }

  private async selectCompletion(
    current: FileIndex,
    position: Position,
    context: SuggestionContext,
  ): Promise<SuggestionCandidateSelection> {
    const projectSuggestions = context.kind === 'hlslCode'
      ? collectVisibleProjectSuggestions({
        index: current,
        store: this.index.store,
        visibleUriKeys: await this.visibleUriKeys(current.uri),
        position,
      }).filter((suggestion) => suggestion.name.startsWith(context.prefix.text))
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
  ): Promise<SuggestionCandidateSelection> {
    const visibleUriKeys = await this.visibleUriKeys(current.uri);
    return {
      suggestions: collectMemberSuggestions(
        current,
        this.index.store,
        this.index.global,
        visibleUriKeys,
        receiver,
        prefix,
        position,
      ),
    };
  }

  private async selectSignatures(
    current: FileIndex,
    position: Position,
    context: SuggestionContext,
    name: string,
    activeParameter: number,
  ): Promise<SuggestionCandidateSelection> {
    const projectSuggestions = collectVisibleProjectFunctionSuggestions({
      index: current,
      store: this.index.store,
      visibleUriKeys: await this.visibleUriKeys(current.uri),
      position,
      name,
    });
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

  private visibleUriKeys(uri: string): Promise<Set<string>> {
    return collectVisibleUriKeys(this.index.store, this.includeContext, uri);
  }
}

interface CollectProjectSuggestionsInput {
  readonly index: FileIndex;
  readonly store: IndexStoreReader;
  readonly visibleUriKeys: ReadonlySet<string>;
  readonly position: Position;
}

function isScopedVisible(symbol: SymbolEntry, position: Position): boolean {
  return (symbol.kind === 'parameter' || symbol.kind === 'localVariable')
    && !!symbol.scopeRange
    && inRange(position, symbol.scopeRange)
    && isBeforeOrAt(symbol.location.range.start, position);
}

function laterThan(a: Position, b: Position): boolean {
  return a.line > b.line || (a.line === b.line && a.character > b.character);
}

function collectScopedSuggestions(index: FileIndex, position: Position): SymbolEntry[] {
  const byName = new Map<string, SymbolEntry>();
  for (const symbol of index.symbols) {
    if (!isScopedVisible(symbol, position)) continue;
    const previous = byName.get(symbol.name);
    if (!previous || laterThan(symbol.location.range.start, previous.location.range.start)) {
      byName.set(symbol.name, symbol);
    }
  }
  return [...byName.values()];
}

function isGlobalSuggestion(symbol: SymbolEntry): boolean {
  return symbol.kind !== 'parameter'
    && symbol.kind !== 'localVariable'
    && symbol.kind !== 'structMember';
}

function functionSignatureKey(symbol: FunctionSymbolEntry): string {
  return symbol.parameters.map((parameter) => parameter.type).join(',');
}

function rangeKey(symbol: SymbolEntry): string {
  const { range } = symbol.location;
  return [
    uriKey(symbol.location.uri),
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

function dedupeKey(symbol: SymbolEntry): string {
  if (symbol.kind === 'function') {
    return [
      symbol.name,
      symbol.kind,
      functionSignatureKey(symbol as FunctionSymbolEntry),
      rangeKey(symbol),
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

function collectVisibleProjectSuggestions(
  input: CollectProjectSuggestionsInput,
): ShaderSuggestion[] {
  const ordered: Array<{ symbol: SymbolEntry; rank: number }> = [];
  for (const symbol of collectScopedSuggestions(input.index, input.position)) {
    ordered.push({ symbol, rank: 0 });
  }
  for (const symbol of input.index.symbols) {
    if (isGlobalSuggestion(symbol)) ordered.push({ symbol, rank: 1 });
  }
  for (const visibleKey of input.store.uris()) {
    if (uriKey(input.index.uri) === visibleKey || !input.visibleUriKeys.has(visibleKey)) continue;
    const visibleIndex = input.store.get(visibleKey);
    if (!visibleIndex) continue;
    for (const symbol of visibleIndex.symbols) {
      if (isGlobalSuggestion(symbol)) ordered.push({ symbol, rank: 2 });
    }
  }

  const seen = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  for (const candidate of ordered) {
    const key = dedupeKey(candidate.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(symbolToSuggestion(candidate.symbol, candidate.rank));
  }
  return suggestions;
}

function collectVisibleProjectFunctionSuggestions(
  input: CollectProjectSuggestionsInput & { readonly name: string },
): ShaderSuggestion[] {
  const ordered: Array<{ symbol: FunctionSymbolEntry; rank: number }> = [];
  for (const symbol of input.index.symbols) {
    if (symbol.kind === 'function' && symbol.name === input.name) {
      ordered.push({ symbol: symbol as FunctionSymbolEntry, rank: 1 });
    }
  }
  for (const visibleKey of input.store.uris()) {
    if (uriKey(input.index.uri) === visibleKey || !input.visibleUriKeys.has(visibleKey)) continue;
    const visibleIndex = input.store.get(visibleKey);
    if (!visibleIndex) continue;
    for (const symbol of visibleIndex.symbols) {
      if (symbol.kind === 'function' && symbol.name === input.name) {
        ordered.push({ symbol: symbol as FunctionSymbolEntry, rank: 2 });
      }
    }
  }

  const seen = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  for (const candidate of ordered) {
    const key = rangeKey(candidate.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(symbolToSuggestion(candidate.symbol, candidate.rank));
  }
  return suggestions;
}

function collectMemberSuggestions(
  index: FileIndex,
  store: IndexStoreReader,
  global: GlobalSymbolReader | null | undefined,
  visibleUriKeys: ReadonlySet<string>,
  receiver: string,
  memberPrefix: string,
  position: Position,
): ShaderSuggestion[] {
  const receiverType = inferReceiverTypeForCompletion(
    index,
    global,
    receiver,
    position,
    { visibleUriKeys },
  );
  if (!receiverType) return [];

  const indexes = [index];
  for (const key of store.uris()) {
    if (key === uriKey(index.uri) || !visibleUriKeys.has(key)) continue;
    const visibleIndex = store.get(key);
    if (visibleIndex) indexes.push(visibleIndex);
  }

  const seen = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  for (const candidateIndex of indexes) {
    const rank = uriKey(candidateIndex.uri) === uriKey(index.uri) ? 1 : 2;
    for (const symbol of candidateIndex.symbols) {
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
