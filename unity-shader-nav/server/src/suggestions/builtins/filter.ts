import type { SuggestionContext } from '../context';
import type { ShaderSuggestion } from '../types';
import type { BuiltinEntry } from './types';
import { BUILTIN_ENTRIES } from './catalog';
import { builtinEntryToSuggestion } from './types';

const SHADERLAB_STATE_VALUE_NAMES = new Set([
  'Off',
  'On',
  'Back',
  'Front',
  'Always',
  'LEqual',
  'Less',
  'Greater',
  'Equal',
  'Never',
  'GEqual',
  'NotEqual',
  'Zero',
  'One',
  'SrcColor',
  'SrcAlpha',
  'DstColor',
  'DstAlpha',
  'OneMinusSrcColor',
  'OneMinusSrcAlpha',
  'OneMinusDstColor',
  'OneMinusDstAlpha',
  'Add',
  'Sub',
  'RevSub',
  'Min',
  'Max',
  'Replace',
  'Keep',
  'Invert',
  'IncrSat',
  'DecrSat',
  'IncrWrap',
  'DecrWrap',
]);

function isShaderLabStateValue(entry: BuiltinEntry): boolean {
  return SHADERLAB_STATE_VALUE_NAMES.has(entry.name);
}

function matchesPrefix(suggestion: ShaderSuggestion, prefix: string): boolean {
  return suggestion.name.startsWith(prefix);
}

export function collectBuiltinSuggestions(context: SuggestionContext): ShaderSuggestion[] {
  if (context.kind === 'comment' || context.kind === 'string') return [];

  const entries = BUILTIN_ENTRIES.filter((entry) => {
    switch (context.kind) {
      case 'hlslCode':
        return entry.name.length > 0 && ['hlsl', 'unitycg', 'urp', 'hdrp'].includes(entry.category);
      case 'semanticPosition':
        return entry.kind === 'semantic';
      case 'shaderLabCode':
        return entry.category === 'shaderlab' && !isShaderLabStateValue(entry);
      case 'shaderLabStateValue':
        return isShaderLabStateValue(entry);
      default:
        return false;
    }
  });

  return entries
    .map(builtinEntryToSuggestion)
    .filter((suggestion) => matchesPrefix(suggestion, context.prefix.text));
}
