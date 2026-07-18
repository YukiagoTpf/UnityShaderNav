import type { BuiltinEntry } from '../../vocabulary';
import type { ShaderSuggestion } from '../types';

export function builtinEntryToSuggestion(entry: BuiltinEntry): ShaderSuggestion {
  return {
    name: entry.name,
    kind: entry.kind,
    source: 'builtin',
    detail: entry.detail,
    documentation: entry.documentation,
    insertText: entry.insertText,
    sortText: `9_${entry.name}`,
    returnType: entry.returnType,
    parameters: entry.parameters?.map((parameter) => ({ ...parameter })),
    declaredType: entry.declaredType,
    parentType: entry.parentType,
  };
}
