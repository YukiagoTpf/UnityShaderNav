import type { Range } from './symbols';

export const EXTENSION_ID = 'unity-shader-nav';
export const SERVER_NAME = 'UnityShaderNav Language Server';

/** Pull + full-snapshot notification for the observable indexing lifecycle. */
export const INDEX_STATUS_REQUEST = 'unityShaderNav/indexStatus';
export const INDEX_STATUS_NOTIFICATION = 'unityShaderNav/indexStatusChanged';

export type IndexingOperation = 'initial' | 'rebuild' | 'recovery';
export type IndexFailureCategory =
  | 'package-resolution'
  | 'parser-initialization'
  | 'indexing';

export interface IndexFailure {
  readonly category: IndexFailureCategory;
  readonly message: string;
}

export type WorkspaceIndexLifecycle =
  | {
      readonly state: 'indexing';
      readonly operation: IndexingOperation;
      readonly servingRevision?: number;
    }
  | {
      readonly state: 'ready';
      readonly revision: number;
      readonly warningCount: number;
    }
  | {
      readonly state: 'failed';
      readonly servingRevision?: number;
      readonly failure: IndexFailure;
    };

export interface WorkspaceIndexStatus {
  readonly folderUri: string;
  readonly mode: 'unity' | 'standalone';
  readonly lifecycle: WorkspaceIndexLifecycle;
}

export interface IndexStatusSnapshot {
  readonly statusSequence: number;
  readonly workspaces: readonly WorkspaceIndexStatus[];
}

export * from './cache';
export * from './settings';
export * from './structure';
export * from './symbols';

/** Custom pull request: client asks for dimmed preprocessor-branch ranges. */
export const INACTIVE_REGIONS_REQUEST = 'unityShaderNav/inactiveRegions';

export type DimReason = 'inactive' | 'variant';

export interface VariantContext {
  /** keyword names that are currently enabled for this document */
  readonly activeKeywords: ReadonlySet<string>;
}

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
  /** lets the client render definitely inactive and variant-gated regions distinctly */
  regions: InactiveRegion[];
}
