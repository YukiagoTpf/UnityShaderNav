import type { ShaderSuggestion } from '../types';
import type { SuggestionContext } from '../context';
import { findBuiltinFunctions } from '../../vocabulary';
import { builtinEntryToSuggestion } from './toSuggestion';

export function collectBuiltinFunctionSuggestions(
  name: string,
  context: SuggestionContext,
): ShaderSuggestion[] {
  if (context.kind !== 'hlslCode') return [];

  return findBuiltinFunctions(name)
    .map(builtinEntryToSuggestion);
}
