import type { ShaderSuggestion } from '../types';
import type { SuggestionContext } from '../context';
import { BUILTIN_ENTRIES } from './catalog';
import { builtinEntryToSuggestion } from './types';

export function collectBuiltinFunctionSuggestions(
  name: string,
  context: SuggestionContext,
): ShaderSuggestion[] {
  if (context.kind !== 'hlslCode') return [];

  return BUILTIN_ENTRIES
    .filter((entry) =>
      entry.name === name
      && entry.kind === 'function'
      && Array.isArray(entry.parameters)
    )
    .map(builtinEntryToSuggestion);
}
