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

export * from './adapter';
export * from './cache';
export * from './compiler';
export * from './csharpProperties';
export * from './gpuCapture';
export * from './materialContext';
export * from './materials';
export * from './portability';
export * from './propertyRename';
export * from './settings';
export * from './shaderGraph';
export * from './structure';
export * from './symbols';
export * from './variants';

/** Custom pull request: client asks for dimmed preprocessor-branch ranges. */
export const INACTIVE_REGIONS_REQUEST = 'unityShaderNav/inactiveRegions';

/** Client → server: set the active VariantContext for a document. null = conservative. */
export const VARIANT_CONTEXT_CHANGED_NOTIFICATION = 'unityShaderNav/variantContextChanged';

/** Client → server: query the current VariantContext for a document (restore on reload). */
export const VARIANT_CONTEXT_REQUEST = 'unityShaderNav/getVariantContext';

/** Client → server: fetch the variant keywords declared in a document. */
export const GET_VARIANT_KEYWORDS_REQUEST = 'unityShaderNav/getVariantKeywords';

/** Server → client: read the exact current C# source without a C# provider. */
export const CSHARP_CURRENT_SOURCE_REQUEST = 'unityShaderNav/csharpCurrentSource';

/** Client → server: an observable C# buffer or saved source changed. */
export const CSHARP_CURRENT_SOURCE_CHANGED_NOTIFICATION =
  'unityShaderNav/csharpCurrentSourceChanged';

/** Client → server: list revision-grounded include-point Contexts for a shared file. */
export const INCLUDE_POINT_CONTEXTS_REQUEST = 'unityShaderNav/includePointContexts';

/** Client → server: mirror the client-owned, session-only Context selection. */
export const INCLUDE_POINT_CONTEXT_CHANGED_NOTIFICATION =
  'unityShaderNav/includePointContextChanged';

/** CodeLens action: open the user-facing contract for declared Variant cost. */
export const OPEN_VARIANT_COST_DOCUMENTATION_COMMAND =
  'unityShaderNav.openVariantCostDocumentation';
export const VARIANT_COST_DOCUMENTATION_URL =
  'https://github.com/YukiagoTpf/UnityShaderNav/blob/main/docs/usage.md#declared-variant-cost';

export type DimReason = 'inactive' | 'variant';

export interface VariantContext {
  /** keyword names that are currently enabled for this document */
  readonly activeKeywords: ReadonlySet<string>;
}

export interface VariantContextChangedParams {
  readonly textDocument: { readonly uri: string };
  readonly context: VariantContext | null;
}

export interface VariantContextParams {
  readonly textDocument: { readonly uri: string };
}

export interface VariantContextResult {
  readonly context: VariantContext | null;
}

export interface GetVariantKeywordsParams {
  readonly textDocument: { readonly uri: string };
}

export interface GetVariantKeywordsResult {
  readonly keywords: string[];
}

export interface CSharpCurrentSourceParams {
  readonly uri: string;
}

export interface CSharpCurrentSourceResult {
  readonly text: string;
  readonly availability: 'open-buffer' | 'closed-saved';
}

export interface CSharpCurrentSourceChangedParams {
  readonly uri: string;
}

export interface IncludePointContext {
  readonly id: string;
  readonly shaderName: string;
  readonly shaderUri: string;
  readonly subShaderIndex: number;
  readonly passIndex?: number;
  readonly passName?: string;
  readonly stage: import('./structure').ShaderStage;
  readonly entryPoint: string;
  /** The concrete directive that reaches the requested shared file. */
  readonly includeLocation: { readonly uri: string; readonly range: Range };
  /** Number of include directives from the Shader program to this file. */
  readonly chainDepth: number;
}

export interface IncludePointContextsParams {
  readonly textDocument: { readonly uri: string };
}

export interface IncludePointContextsResult {
  /** Absent while no Published indexed revision owns the document. */
  readonly folderUri?: string;
  readonly revision?: number;
  /** Opaque identity; changes for every publication, including live edits. */
  readonly publicationId?: string;
  readonly contexts: IncludePointContext[];
}

export interface IncludePointContextSelection {
  readonly publicationId: string;
  readonly contextId: string;
}

export interface IncludePointContextChangedParams {
  readonly folderUri: string;
  readonly selection: IncludePointContextSelection | null;
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
