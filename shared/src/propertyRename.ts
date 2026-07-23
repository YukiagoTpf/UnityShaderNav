import type { CSharpPropertyReferenceData } from './csharpProperties';
import type { AdapterEvidenceProvenance } from './materials';
import type { Range } from './symbols';

export const PREVIEW_PROPERTY_RENAME_COMMAND =
  'unityShaderNav.previewPropertyRename';
export const PROPERTY_RENAME_PREVIEW_REQUEST =
  'unityShaderNav/propertyRenamePreview';
export const PROPERTY_RENAME_BEGIN_REQUEST =
  'unityShaderNav/propertyRenameBegin';
export const PROPERTY_RENAME_FINISH_REQUEST =
  'unityShaderNav/propertyRenameFinish';

export interface PropertyRenameParams {
  readonly textDocument: { readonly uri: string };
  readonly position: { readonly line: number; readonly character: number };
  readonly newName: string;
}

export interface PropertyRenameSourceEdit {
  readonly kind: 'source-edit';
  readonly group: 'shader-source' | 'csharp-source';
  readonly uri: string;
  readonly range: Range;
  /** Exact text observed during planning and used for rollback. */
  readonly oldText: string;
  readonly newText: string;
  readonly provenance:
    | { readonly kind: 'published-index' }
    | {
        readonly kind: 'csharp-adapter';
        readonly evidence: CSharpPropertyReferenceData;
      };
}

export interface PropertyRenameMaterialEdit {
  readonly kind: 'material-asset-edit';
  readonly group: 'material-asset';
  readonly guid: string;
  readonly path: string;
  readonly oldName: string;
  readonly newName: string;
  readonly provenance: AdapterEvidenceProvenance<'material-usages'>;
}

export type PropertyRenamePreviewItem =
  | PropertyRenameSourceEdit
  | PropertyRenameMaterialEdit;

export interface PropertyRenamePreviewGroup {
  readonly kind: PropertyRenamePreviewItem['group'];
  readonly label: string;
  readonly items: readonly PropertyRenamePreviewItem[];
}

export type PropertyRenameBlockerCode =
  | 'adapter-unavailable'
  | 'ambiguous-evidence'
  | 'dynamic-reference'
  | 'read-only-package'
  | 'source-conflict'
  | 'unsupported-asset-update';

export interface PropertyRenameBlocker {
  readonly code: PropertyRenameBlockerCode;
  readonly message: string;
  readonly uri?: string;
  readonly range?: Range;
}

export interface PropertyRenameManualFollowUp {
  readonly message: string;
  readonly path?: string;
}

export interface PropertyRenamePreview {
  /** Hash of every edit, blocker, provenance envelope, and source revision. */
  readonly previewId: string;
  readonly oldName: string;
  readonly newName: string;
  readonly groups: readonly PropertyRenamePreviewGroup[];
  readonly blockers: readonly PropertyRenameBlocker[];
  readonly manualFollowUps: readonly PropertyRenameManualFollowUp[];
  readonly canApply: boolean;
}

export type PropertyRenamePreviewResult =
  | { readonly status: 'ready'; readonly preview: PropertyRenamePreview }
  | { readonly status: 'failure'; readonly message: string };

export interface PropertyRenameBeginParams extends PropertyRenameParams {
  readonly previewId: string;
}

export type PropertyRenameBeginResult =
  | {
      readonly status: 'ready';
      readonly transactionId: string;
      readonly edits: readonly PropertyRenameSourceEdit[];
    }
  | {
      readonly status: 'conflict' | 'failure';
      readonly message: string;
    };

export interface PropertyRenameFinishParams {
  readonly textDocument: { readonly uri: string };
  readonly transactionId: string;
  readonly sourceApplied: boolean;
}

export type PropertyRenameFinishResult =
  | { readonly status: 'committed' | 'rolled-back' }
  | { readonly status: 'failed'; readonly message: string };
