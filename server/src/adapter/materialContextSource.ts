import type {
  MaterialContextAsset,
  MaterialContextKeyword,
  MaterialContextProgram,
  MaterialContextTextureBinding,
  MaterialContextUnavailableReason,
  MaterialPropertyValue,
  SelectedMaterialContext,
} from '@unity-shader-nav/shared';

export interface MaterialContextSourceIdentity {
  readonly projectId: string;
  readonly instanceId: string;
}

/** Adapter payload before the registry stamps trusted provenance. */
export type MaterialContextSourceSnapshot =
  | {
      readonly status: 'none';
    }
  | {
      readonly status: 'selected';
      readonly selectionId: string;
      readonly collectedAt: number;
      readonly material: MaterialContextAsset;
      readonly shader: MaterialContextAsset;
      readonly selectedProgram?: MaterialContextProgram;
      readonly properties: readonly MaterialPropertyValue[];
      readonly textures: readonly MaterialContextTextureBinding[];
      readonly materialKeywords: readonly MaterialContextKeyword[];
    };

/** Transport-neutral boundary for the connected Editor's current selection. */
export interface MaterialContextSource {
  readonly identity: MaterialContextSourceIdentity;
  selectedMaterialContext(): Promise<MaterialContextSourceSnapshot>;
  onDidChangeSelection?(listener: () => void): { dispose(): void };
}

export type TrustedMaterialContextResult =
  | {
      readonly availability: 'available';
      readonly context: SelectedMaterialContext;
    }
  | {
      readonly availability: 'unknown';
      readonly reason: MaterialContextUnavailableReason;
    };

export interface MaterialContextProvider {
  selectedMaterialContext(): Promise<TrustedMaterialContextResult>;
}

export function unknownMaterialContext(
  reason: MaterialContextUnavailableReason,
): Extract<TrustedMaterialContextResult, { readonly availability: 'unknown' }> {
  return { availability: 'unknown', reason };
}
