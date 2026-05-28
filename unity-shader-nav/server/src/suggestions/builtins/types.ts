import type { ShaderParameter, ShaderSuggestion } from '../types';

export const BUILTIN_CATEGORIES = ['hlsl', 'unitycg', 'urp', 'hdrp', 'shaderlab', 'semantic'] as const;

export type BuiltinCategory = typeof BUILTIN_CATEGORIES[number];

export interface BuiltinEntry {
  name: string;
  kind: 'function' | 'keyword' | 'semantic' | 'state' | 'macro' | 'type';
  category: BuiltinCategory;
  detail?: string;
  documentation?: string;
  insertText?: string;
  returnType?: string;
  parameters?: ShaderParameter[];
}

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
    parameters: entry.parameters,
  };
}
