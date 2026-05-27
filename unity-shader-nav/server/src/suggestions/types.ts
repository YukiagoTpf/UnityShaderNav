import type { SymbolKind } from '@unity-shader-nav/shared';

export type ShaderSuggestionSource = 'project' | 'builtin';
export type ShaderSuggestionKind = SymbolKind | 'keyword' | 'semantic' | 'state' | 'function' | 'type';

export interface ShaderParameter {
  name: string;
  type: string;
  documentation?: string;
}

export interface ShaderSuggestion {
  name: string;
  kind: ShaderSuggestionKind;
  source: ShaderSuggestionSource;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  returnType?: string;
  parameters?: ShaderParameter[];
  declaredType?: string;
  parentType?: string;
}
