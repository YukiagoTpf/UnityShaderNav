import type {
  AdapterSourceRevision,
  AdapterUnavailableReason,
} from './adapter';
import type {
  AdapterEvidenceProvenance,
  MaterialPropertyValue,
} from './materials';

/** Adapter capability that supplies the currently selected Material evidence. */
export const MATERIAL_CONTEXT_ADAPTER_FEATURE = 'material-context';

/** Client pull for the selected Material Context relevant to one workspace URI. */
export const MATERIAL_CONTEXT_REQUEST = 'unityShaderNav/materialContext';

/** Server notification that the Adapter selection identity may have changed. */
export const MATERIAL_CONTEXT_CHANGED_NOTIFICATION =
  'unityShaderNav/materialContextChanged';

export interface MaterialContextAsset {
  readonly name: string;
  /** Project-relative `Assets/...` or `Packages/...` path. */
  readonly path: string;
  readonly revision: AdapterSourceRevision;
}

export interface MaterialContextTextureAsset {
  readonly name: string;
  readonly guid: string;
  /** Project-relative AssetDatabase path. */
  readonly path: string;
}

export interface MaterialContextTextureBinding {
  readonly propertyName: string;
  readonly texture: MaterialContextTextureAsset | null;
}

export interface MaterialContextKeyword {
  readonly name: string;
  readonly enabled: boolean;
  /** Only LocalKeyword evidence can resolve source branches conservatively. */
  readonly scope: 'local' | 'legacy';
}

export interface MaterialContextProgram {
  readonly subShaderIndex: number;
  readonly passIndex?: number;
  readonly passName?: string;
}

export interface DrawKeywordUnknown {
  readonly status: 'unknown';
  readonly reason: 'draw-evidence-required';
}

/**
 * Adapter-derived editor selection evidence. This is intentionally not a
 * final draw Context: global and engine-added keyword state need draw evidence.
 */
export interface SelectedMaterialContext {
  readonly selectionId: string;
  readonly material: MaterialContextAsset;
  readonly shader: MaterialContextAsset;
  readonly selectedProgram?: MaterialContextProgram;
  readonly properties: readonly MaterialPropertyValue[];
  readonly textures: readonly MaterialContextTextureBinding[];
  readonly keywords: {
    readonly material: readonly MaterialContextKeyword[];
    readonly global: DrawKeywordUnknown;
    readonly engineAdded: DrawKeywordUnknown;
  };
  readonly provenance: AdapterEvidenceProvenance<
    typeof MATERIAL_CONTEXT_ADAPTER_FEATURE
  >;
}

export type MaterialContextUnavailableReason =
  | AdapterUnavailableReason
  | 'capability-unavailable'
  | 'source-unavailable'
  | 'source-identity-mismatch'
  | 'connection-changed'
  | 'selection-changed'
  | 'no-selection'
  | 'asset-deleted'
  | 'stale-source'
  | 'invalid-evidence';

export interface MaterialContextParams {
  readonly textDocument: { readonly uri: string };
}

export type MaterialContextResult =
  | {
      readonly status: 'available';
      readonly folderUri: string;
      readonly revision: number;
      readonly publicationId: string;
      readonly context: SelectedMaterialContext;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: MaterialContextUnavailableReason;
    };
