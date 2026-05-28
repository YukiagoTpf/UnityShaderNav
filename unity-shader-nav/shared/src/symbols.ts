import type { StructureResult } from './structure';

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
  receiver?: string;
}

export interface TypeInferenceEntry {
  receiver: string;
  callName: string;
  assignmentRange: Range;
  scope?: string;
  scopeRange?: Range;
}

export type ShaderLabPropertyType =
  | '2D' | '2DArray' | '3D' | 'Cube' | 'CubeArray'
  | 'Color' | 'Vector' | 'Float' | 'Range' | 'Int';

export interface ShaderLabPropertyEntry {
  /** Identifier as written, e.g. "_MainTex". Case-sensitive. */
  name: string;
  /** Range of the name token only (used as F12 origin selection range). */
  nameRange: Range;
  /** Range covering the full declaration line (name through default literal). */
  declarationRange: Range;
  /** Whitelisted type; null for unrecognised types (still indexed by name). */
  type: ShaderLabPropertyType | null;
}

export interface FileIndex {
  uri: string;
  symbols: SymbolEntry[];
  references: ReferenceEntry[];
  typeInferences?: TypeInferenceEntry[];
  /** Only populated for .shader files. */
  structure?: StructureResult;
  /** Only populated for .shader files. */
  properties?: ShaderLabPropertyEntry[];
}
