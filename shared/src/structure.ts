export type BlockKind = 'HLSLPROGRAM' | 'CGPROGRAM' | 'HLSLINCLUDE' | 'CGINCLUDE';

export type ShaderStage =
  | 'vertex'
  | 'fragment'
  | 'geometry'
  | 'hull'
  | 'domain'
  | 'surface'
  | 'kernel'
  | 'raytracing';

/**
 * Source-order preprocessor fact retained specifically for revision-bound
 * include-point Context derivation. Conditional directives are kept as known
 * include edges, but never promoted to deterministic macro state.
 */
export interface ShaderContextDirectiveEntry {
  kind: 'include' | 'define' | 'undef';
  /** Include path or macro name, depending on kind. */
  name: string;
  range: import('./symbols').Range;
  conditional: boolean;
  /** ShaderLab block index; absent for a standalone HLSL/CG source. */
  blockIndex?: number;
}

export interface ShaderContextVariantPragmaEntry {
  keywords: string[];
  stage?: ShaderStage;
  conditional: boolean;
  /** ShaderLab block index; absent for a standalone HLSL/CG source. */
  blockIndex?: number;
}

export interface ShaderContextStageEntry {
  stage: ShaderStage;
  entryPoint: string;
  /** Extra deterministic defines authored on a `#pragma kernel` line. */
  defines: string[];
}

/** One real ShaderLab program block from which include chains may originate. */
export interface ShaderProgramContextEntry {
  blockIndex: number;
  shaderName: string;
  subShaderIndex: number;
  passIndex?: number;
  passName?: string;
  stages: ShaderContextStageEntry[];
  /** Applicable HLSLINCLUDE/CGINCLUDE blocks, in source order. */
  sharedBlockIndices: number[];
}

/** Optional cache-compatible facts used to derive the Context Matrix. */
export interface ShaderContextSourceFacts {
  directives: ShaderContextDirectiveEntry[];
  variantPragmas: ShaderContextVariantPragmaEntry[];
  /** Present only for `.shader` sources. */
  programs?: ShaderProgramContextEntry[];
}

export interface ShaderLabBlock {
  kind: BlockKind;
  /** Line on which the HLSLPROGRAM/CGPROGRAM directive appears (0-based). */
  startLine: number;
  /** Line on which the ENDHLSL/ENDCG directive appears (0-based). Inclusive. */
  endLine: number;
  /** Line range of HLSL CONTENT (exclusive of directives): startLine+1 .. endLine-1. */
  contentStartLine: number;
  contentEndLine: number;
  /** True if the matching ENDHLSL/ENDCG was never found before EOF. */
  unterminated: boolean;
}

export type ShaderLabNodeKind = 'shader' | 'properties' | 'subshader' | 'pass';

export interface ShaderLabStructureNode {
  kind: ShaderLabNodeKind;
  /** Shader "Name" → "Name"; Pass { Name "X" } → "X"; else undefined. */
  name?: string;
  /** Range of the opening directive line (0-based). */
  headerLine: number;
  /** Closing brace line (0-based); equals headerLine if not found. */
  closeLine: number;
  children: ShaderLabStructureNode[];
}

export interface ScanResult {
  blocks: ShaderLabBlock[];
}

export interface StructureResult {
  /** Top-level shader nodes; usually exactly one. */
  shaders: ShaderLabStructureNode[];
}

export interface ShaderLabShaderNameEntry {
  name: string;
  nameRange: import('./symbols').Range;
  declarationRange: import('./symbols').Range;
}

export interface ShaderLabPassNameEntry {
  shaderName: string;
  name: string;
  canonicalName: string;
  nameRange: import('./symbols').Range;
  declarationRange: import('./symbols').Range;
}

export interface ShaderLabFallbackReference {
  kind: 'fallback';
  shaderName: string;
  shaderNameRange: import('./symbols').Range;
  directiveRange: import('./symbols').Range;
}

export interface ShaderLabUsePassReference {
  kind: 'usePass';
  shaderName: string;
  passName: string;
  canonicalPassName: string;
  shaderNameRange: import('./symbols').Range;
  passNameRange: import('./symbols').Range;
  directiveRange: import('./symbols').Range;
}

export interface ShaderLabNameFacts {
  shaders: ShaderLabShaderNameEntry[];
  passes: ShaderLabPassNameEntry[];
  references: Array<ShaderLabFallbackReference | ShaderLabUsePassReference>;
}

export interface ShaderLabMaterialFieldEntry {
  name: string;
  type: string;
  packOffset?: string;
  nameRange: import('./symbols').Range;
  declarationRange: import('./symbols').Range;
  conditional: boolean;
}

export interface ShaderLabMaterialCbufferEntry {
  name: string;
  nameRange: import('./symbols').Range;
  declarationRange: import('./symbols').Range;
  fields: ShaderLabMaterialFieldEntry[];
  blockIndex: number;
  blockKind: BlockKind;
  insertionPosition: import('./symbols').Position;
  fieldIndent: string;
  conditional: boolean;
  /** True when non-declaration content prevents an exact field inventory. */
  opaque: boolean;
  complete: boolean;
}

export interface ShaderLabProgramBlockEntry {
  blockIndex: number;
  kind: BlockKind;
  startLine: number;
  endLine: number;
  insertionPosition: import('./symbols').Position;
  indent: string;
  unterminated: boolean;
}

export interface ShaderLabMaterialFacts {
  srpEvidence: boolean;
  subShaderCount: number;
  hasIncludes: boolean;
  lineEnding: '\n' | '\r\n';
  cbuffers: ShaderLabMaterialCbufferEntry[];
  programBlocks: ShaderLabProgramBlockEntry[];
}
