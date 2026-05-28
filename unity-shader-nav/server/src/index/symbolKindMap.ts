import { SymbolKind as LspSymbolKind } from 'vscode-languageserver/node';
import type { SymbolKind as IndexSymbolKind } from '@unity-shader-nav/shared';

export const SYMBOL_KIND_MAP: Record<string, LspSymbolKind> = {
  function: LspSymbolKind.Function,
  variable: LspSymbolKind.Variable,
  struct: LspSymbolKind.Struct,
  structMember: LspSymbolKind.Field,
  macro: LspSymbolKind.Constant,
  cbuffer: LspSymbolKind.Struct,
};

export const HIDDEN_SYMBOL_KINDS: ReadonlySet<IndexSymbolKind> = new Set([
  'parameter',
  'localVariable',
]);
