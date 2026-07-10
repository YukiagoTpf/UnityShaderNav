export type BlockKind = 'HLSLPROGRAM' | 'CGPROGRAM' | 'HLSLINCLUDE' | 'CGINCLUDE';

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

export type ShaderLabNodeKind = 'shader' | 'subshader' | 'pass';

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
