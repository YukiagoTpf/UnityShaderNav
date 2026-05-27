import { CompletionItemKind, type CompletionItem } from 'vscode-languageserver/node';
import type { ShaderSuggestion, ShaderSuggestionKind } from './types';

export function signatureLabelOf(suggestion: ShaderSuggestion): string {
  if (suggestion.kind !== 'function') return suggestion.detail ?? suggestion.name;
  const returnType = suggestion.returnType ?? suggestion.declaredType ?? 'void';
  const parameters = suggestion.parameters
    ?.map((parameter) => `${parameter.type} ${parameter.name}`)
    .join(', ') ?? '';
  return `${returnType} ${suggestion.name}(${parameters})`;
}

export function symbolKindToCompletionItemKind(kind: ShaderSuggestionKind): CompletionItemKind {
  switch (kind) {
    case 'function':
      return CompletionItemKind.Function;
    case 'struct':
    case 'type':
      return CompletionItemKind.Struct;
    case 'structMember':
      return CompletionItemKind.Field;
    case 'parameter':
    case 'localVariable':
    case 'variable':
      return CompletionItemKind.Variable;
    case 'macro':
      return CompletionItemKind.Constant;
    case 'cbuffer':
      return CompletionItemKind.Module;
    case 'keyword':
    case 'semantic':
    case 'state':
      return CompletionItemKind.Keyword;
    default:
      return CompletionItemKind.Text;
  }
}

export function toCompletionItem(suggestion: ShaderSuggestion): CompletionItem {
  const detail = suggestion.detail
    ?? (suggestion.kind === 'function'
      ? signatureLabelOf(suggestion)
      : suggestion.declaredType
        ? `${suggestion.declaredType} ${suggestion.name}`
        : undefined);

  return {
    label: suggestion.name,
    kind: symbolKindToCompletionItemKind(suggestion.kind),
    detail,
    documentation: suggestion.documentation,
    insertText: suggestion.insertText,
    sortText: suggestion.sortText,
  };
}
