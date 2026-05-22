export type SymbolKind =
  | 'function'
  | 'variable'
  | 'parameter'
  | 'localVariable'
  | 'struct'
  | 'structMember'
  | 'macro'
  | 'cbuffer';

export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  location: { uri: string; range: Range };
  scope?: string;
  parentType?: string;
  scopeRange?: Range;
  declaredType?: string;
}

export interface FunctionParameter {
  name: string;
  type: string;
  range: Range;
}

export interface FunctionSymbolEntry extends SymbolEntry {
  kind: 'function';
  returnType: string;
  parameters: FunctionParameter[];
}

export type ReferenceContext = 'call' | 'type' | 'member' | 'pragma' | 'identifier' | 'include';

export interface ReferenceEntry {
  name: string;
  location: { uri: string; range: Range };
  context: ReferenceContext;
}

export interface FileIndex {
  uri: string;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
}
