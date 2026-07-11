import type { SuggestionContext } from '../context';
import type { ShaderSuggestion } from '../types';
import {
  builtinEntriesForContext,
  type BuiltinContext,
} from '../../vocabulary';
import { builtinEntryToSuggestion } from './toSuggestion';

function matchesPrefix(suggestion: ShaderSuggestion, prefix: string): boolean {
  return suggestion.name.startsWith(prefix);
}

export function collectBuiltinSuggestions(context: SuggestionContext): ShaderSuggestion[] {
  if (context.kind === 'comment' || context.kind === 'string') return [];

  const vocabularyContext: BuiltinContext = context.kind === 'hlslCode'
    ? 'hlsl'
    : context.kind === 'semanticPosition'
      ? 'semantic'
      : context.kind === 'shaderLabCode'
        ? 'shaderLab'
        : 'shaderLabStateValue';

  return builtinEntriesForContext(vocabularyContext)
    .map(builtinEntryToSuggestion)
    .filter((suggestion) => matchesPrefix(suggestion, context.prefix.text));
}
