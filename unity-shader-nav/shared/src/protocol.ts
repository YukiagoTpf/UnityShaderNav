import type { Range } from './symbols';

export const EXTENSION_ID = 'unity-shader-nav';
export const SERVER_NAME = 'UnityShaderNav Language Server';

export * from './cache';
export * from './settings';
export * from './structure';
export * from './symbols';

/** Custom pull request: client asks for dimmed preprocessor-branch ranges. */
export const INACTIVE_REGIONS_REQUEST = 'unityShaderNav/inactiveRegions';

export type DimReason = 'inactive' | 'variant';

export interface InactiveRegion {
  range: Range;
  reason: DimReason;
}

export interface InactiveRegionsParams {
  // version lets the client drop stale responses (review P2)
  textDocument: { uri: string; version: number };
}

export interface InactiveRegionsResult {
  /** echo of the requested document version so the client can discard stale responses */
  version: number;
  /** carries reason so a future issue can split inactive vs variant presentation */
  regions: InactiveRegion[];
}
