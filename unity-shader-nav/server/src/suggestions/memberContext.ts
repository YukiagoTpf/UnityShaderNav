import type { FileIndex, Position, SymbolEntry } from '@unity-shader-nav/shared';
import type { GlobalSymbolIndex, IndexStore } from '../index';
import { inferReceiverTypeForCompletion } from '../index/chainLookup';
import { uriKey } from '../index/uriKey';
import { symbolToSuggestion } from './projectSymbols';
import type { ShaderSuggestion } from './types';

function memberKey(symbol: SymbolEntry): string {
  return [symbol.name, symbol.parentType ?? ''].join('|');
}

export function collectMemberSuggestions(
  index: FileIndex,
  store: Pick<IndexStore, 'get' | 'uris'>,
  global: GlobalSymbolIndex | null | undefined,
  visibleUriKeys: ReadonlySet<string>,
  receiver: string,
  memberPrefix: string,
  position: Position,
): ShaderSuggestion[] {
  const receiverType = inferReceiverTypeForCompletion(index, global, receiver, position, { visibleUriKeys });
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
    const rank = candidateIndex.uri === index.uri ? 1 : 2;
    for (const symbol of candidateIndex.symbols) {
      if (
        symbol.kind !== 'structMember'
        || symbol.parentType !== receiverType
        || !symbol.name.startsWith(memberPrefix)
      ) {
        continue;
      }
      const key = memberKey(symbol);
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(symbolToSuggestion(symbol, rank));
    }
  }
  return suggestions;
}
