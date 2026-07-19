import type { AdapterSourceRevision } from './adapter';
import type { Range } from './symbols';

/** Adapter capability for File-mode Shader Graph Custom Function facts. */
export const SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY =
  'shader-graph-custom-functions';

export type ShaderGraphPrecision = 'float' | 'half';
export type ShaderGraphPortDirection = 'input' | 'output';

/** Canonical, precision-resolved port signature emitted by the Adapter. */
export interface ShaderGraphCustomFunctionPort {
  readonly name: string;
  readonly direction: ShaderGraphPortDirection;
  /** Exact HLSL parameter type expected after Shader Graph precision resolution. */
  readonly type: string;
}

/** AssetDatabase identity of the include selected by a File-mode node. */
export interface ShaderGraphIncludeSource {
  readonly uri: string;
  readonly assetGuid: string;
  /** Project-relative `Assets/...` or `Packages/...` path. */
  readonly path: string;
}

export interface ShaderGraphCustomFunctionProvenance {
  readonly capability: typeof SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY;
  readonly projectId: string;
  readonly instanceId: string;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  readonly collectedAt: number;
  readonly shaderGraphVersion: string;
  /** Exact saved graph asset from which the Adapter produced this node fact. */
  readonly sourceRevision: AdapterSourceRevision;
}

/** Version-neutral logical fact; no serialized Shader Graph field names escape here. */
export interface ShaderGraphCustomFunctionUsage {
  readonly nodeId: string;
  readonly displayName: string;
  /** Base name as configured in Shader Graph, without `_float` or `_half`. */
  readonly functionName: string;
  readonly precision: ShaderGraphPrecision;
  readonly source: ShaderGraphIncludeSource;
  /** Call-order ports after Adapter-owned version decoding and precision resolution. */
  readonly ports: readonly ShaderGraphCustomFunctionPort[];
  readonly nodeRange: Range;
  readonly functionNameRange: Range;
  readonly sourceRange: Range;
  readonly provenance: ShaderGraphCustomFunctionProvenance;
}

/** Metadata retained on graph-backed Definition and References locations. */
export interface ShaderGraphReferenceData {
  readonly kind: 'shader-graph-custom-function';
  readonly node: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly functionName: string;
  readonly precision: ShaderGraphPrecision;
  readonly source: ShaderGraphIncludeSource;
  readonly provenance: ShaderGraphCustomFunctionProvenance;
}

export interface ShaderGraphReferenceLocation {
  readonly uri: string;
  readonly range: Range;
  readonly data: ShaderGraphReferenceData;
}
