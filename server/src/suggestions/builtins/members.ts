import {
  builtinMemberEntriesForReceiverType,
  findBuiltinMemberFunctions,
} from '../../vocabulary';
import type { SuggestionContext } from '../context';
import type { ShaderSuggestion } from '../types';
import { builtinEntryToSuggestion } from './toSuggestion';

export function collectBuiltinMemberSuggestions(
  receiverType: string,
  prefix: string,
): ShaderSuggestion[] {
  const seenNames = new Set<string>();
  const suggestions: ShaderSuggestion[] = [];
  for (const entry of builtinMemberEntriesForReceiverType(receiverType, prefix)) {
    if (seenNames.has(entry.name)) continue;
    seenNames.add(entry.name);
    suggestions.push(builtinEntryToSuggestion(entry));
  }
  return suggestions;
}

export function collectBuiltinMemberFunctionSuggestions(
  receiverType: string,
  name: string,
  context: SuggestionContext,
): ShaderSuggestion[] {
  if (context.kind !== 'hlslCode') return [];
  return findBuiltinMemberFunctions(receiverType, name).map(builtinEntryToSuggestion);
}
