import type { Range, ShaderLabPropertyType } from './symbols';

/** Adapter capability that supplies serialized Material asset facts. */
export const MATERIAL_USAGES_ADAPTER_FEATURE = 'material-usages';

/** Unity's serialized Material value buckets, not ShaderLab declaration types. */
export type MaterialPropertyValueType =
  | 'float'
  | 'integer'
  | 'vector'
  | 'texture';

/** JSON-safe value retained exactly as reported by the Unity Editor Adapter. */
export type MaterialSerializedValue =
  | null
  | boolean
  | number
  | string
  | readonly MaterialSerializedValue[]
  | { readonly [key: string]: MaterialSerializedValue };

export interface MaterialPropertyValue {
  /** Serialized property identifier, e.g. "_BaseColor". */
  readonly name: string;
  /** Serialized value bucket used to validate the current ShaderLab contract. */
  readonly type: MaterialPropertyValueType;
  readonly serializedValue: MaterialSerializedValue;
}

/** Identity envelope for one Adapter-supplied evidence revision. */
export interface AdapterEvidenceProvenance<Capability extends string = string> {
  readonly capability: Capability;
  readonly projectId: string;
  readonly instanceId: string;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  readonly collectedAt: number;
  readonly sourceRevision: string;
}

/**
 * Persistent Unity Material asset. GUID is identity; path is its current
 * AssetDatabase address.
 */
export interface MaterialAsset {
  readonly guid: string;
  /** Project-relative `Assets/...` or `Packages/...` path. */
  readonly path: string;
  readonly properties: readonly MaterialPropertyValue[];
  readonly provenance: AdapterEvidenceProvenance<
    typeof MATERIAL_USAGES_ADAPTER_FEATURE
  >;
}

export type MaterialPropertyCompatibility =
  | 'compatible'
  | 'type-mismatch'
  | 'not-serialized'
  | 'unknown';

/** Metadata retained on an LSP Location returned for a Material asset. */
export interface MaterialReferenceData {
  readonly kind: 'material-property';
  readonly asset: Pick<MaterialAsset, 'guid' | 'path'>;
  /** null means the Material uses the Shader default without a serialized override. */
  readonly property: MaterialPropertyValue | null;
  readonly shaderPropertyType: ShaderLabPropertyType | null;
  readonly compatibility: MaterialPropertyCompatibility;
  readonly completeness: {
    readonly assetScope: 'complete';
    readonly runtimeMaterials: 'unknown';
  };
  readonly provenance: MaterialAsset['provenance'];
}

/** Location-compatible result with Adapter evidence attached as an annotation. */
export interface MaterialReferenceLocation {
  readonly uri: string;
  readonly range: Range;
  readonly data: MaterialReferenceData;
}
