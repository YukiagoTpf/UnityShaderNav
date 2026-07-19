import type {
  AdapterUnavailableReason,
  MaterialAsset,
} from '@unity-shader-nav/shared';

export interface MaterialSourceIdentity {
  readonly projectId: string;
  readonly instanceId: string;
}

/** Shader asset identity as understood by Unity's AssetDatabase. */
export interface MaterialShaderIdentity {
  readonly name: string;
  readonly path: string;
}

/** Adapter payload before the registry stamps trusted provenance. */
export type AdapterMaterialAsset = Omit<MaterialAsset, 'provenance'>;

export type MaterialSourceSnapshot =
  | {
      readonly assetScope: 'complete';
      readonly revision: string;
      readonly collectedAt: number;
      readonly materials: readonly AdapterMaterialAsset[];
    }
  | {
      readonly assetScope: 'unknown';
      readonly reason: 'asset-scope-unavailable';
    };

/**
 * Pluggable Adapter boundary. A transport can implement it later; tests use a
 * mutable in-memory source so Material revisions never enter the source index.
 */
export interface MaterialSource {
  readonly identity: MaterialSourceIdentity;
  materialsUsingShader(
    shader: MaterialShaderIdentity,
  ): Promise<MaterialSourceSnapshot>;
}

export type MaterialUsageUnknownReason =
  | AdapterUnavailableReason
  | 'capability-unavailable'
  | 'source-unavailable'
  | 'source-identity-mismatch'
  | 'asset-scope-unavailable'
  | 'invalid-evidence';

export type MaterialUsageResult =
  | {
      readonly availability: 'available';
      readonly assetScope: 'complete';
      /** Runtime-created Materials are outside AssetDatabase evidence. */
      readonly runtimeMaterials: 'unknown';
      readonly revision: string;
      readonly materials: readonly MaterialAsset[];
    }
  | {
      readonly availability: 'unknown';
      readonly assetScope: 'unknown';
      readonly runtimeMaterials: 'unknown';
      readonly reason: MaterialUsageUnknownReason;
    };

/** Read-only query surface consumed by Workspace overlays. */
export interface MaterialUsageProvider {
  materialsUsingShader(
    shader: MaterialShaderIdentity,
  ): Promise<MaterialUsageResult>;
}

export function unknownMaterialUsage(
  reason: MaterialUsageUnknownReason,
): Extract<MaterialUsageResult, { readonly availability: 'unknown' }> {
  return {
    availability: 'unknown',
    assetScope: 'unknown',
    runtimeMaterials: 'unknown',
    reason,
  };
}
