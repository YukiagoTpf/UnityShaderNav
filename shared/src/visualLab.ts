import type {
  MaterialContextAsset,
  MaterialContextKeyword,
  MaterialContextProgram,
} from './materialContext';
import type { ShaderStage } from './structure';

/** Adapter capability that renders one controlled Visual Lab preview frame. */
export const VISUAL_LAB_ADAPTER_FEATURE = 'visual-lab-render/v1';

/** Transport method exposed by an Adapter advertising the Visual Lab capability. */
export const VISUAL_LAB_ADAPTER_RENDER_METHOD = 'render-preview';

/** Resolve Adapter-owned final-draw dimensions without rendering a frame. */
export const VISUAL_LAB_ADAPTER_DESCRIBE_METHOD =
  'describe-preview-target';

/** Client command that opens the explicitly user-owned Visual Lab surface. */
export const OPEN_VISUAL_LAB_COMMAND = 'unityShaderNav.openVisualLab';

/** Client pull for the current Visual Lab session state. */
export const VISUAL_LAB_STATE_REQUEST = 'unityShaderNav/visualLabState';

/** User-triggered capture of exactly one comparison slot. */
export const VISUAL_LAB_CAPTURE_REQUEST = 'unityShaderNav/visualLabCapture';

/** Explicitly pin the current Adapter-backed Material as the Visual Lab target. */
export const VISUAL_LAB_SELECT_TARGET_REQUEST =
  'unityShaderNav/visualLabSelectTarget';

/** Full-snapshot notification after any Visual Lab session transition. */
export const VISUAL_LAB_STATE_CHANGED_NOTIFICATION =
  'unityShaderNav/visualLabStateChanged';

export const MAX_VISUAL_LAB_IMAGE_DIMENSION = 1_024;
export const MAX_VISUAL_LAB_PNG_BYTES = 8 * 1_024 * 1_024;

export type VisualLabSlot = 'before' | 'after';
export type VisualLabColorSpace = 'linear' | 'gamma';

/**
 * The exact draw program rendered by the controlled preview.
 *
 * Keyword arrays are complete enabled sets for this draw, sorted in ordinal
 * order without duplicates. Unlike SelectedMaterialContext, this is final draw
 * evidence and therefore includes global and engine-added keywords.
 */
export interface VisualLabShaderContext {
  readonly contextId: string;
  readonly shaderName: string;
  readonly subShaderIndex: number;
  readonly passIndex: number;
  readonly passName?: string;
  readonly stage: ShaderStage;
  readonly entryPoint: string;
  readonly keywords: {
    readonly material: readonly string[];
    readonly global: readonly string[];
    readonly engineAdded: readonly string[];
  };
}

export interface VisualLabPipelineIdentity {
  readonly id: string;
  readonly kind: 'built-in' | 'scriptable';
  readonly name: string;
  /** Required together for a scriptable render-pipeline asset. */
  readonly assetGuid?: string;
  readonly contentHash?: string;
}

export interface VisualLabGraphicsProfile {
  readonly id: string;
  readonly buildTarget: string;
  readonly graphicsApi: string;
  readonly qualityLevel: number;
  readonly renderTarget: {
    readonly width: number;
    readonly height: number;
    readonly format: string;
  };
}

export interface VisualLabAdapterIdentity {
  readonly projectId: string;
  readonly instanceId: string;
  readonly adapterVersion: string;
  readonly unityVersion: string;
}

/**
 * Explicit source Context chosen in the language server. The Adapter resolves
 * only this program; it must not guess an entry point from a Pass.
 */
export interface VisualLabRequestedShaderContext {
  readonly contextId: string;
  readonly shaderUri: string;
  readonly subShaderIndex: number;
  readonly passIndex?: number;
  readonly passName?: string;
  readonly stage: ShaderStage;
  readonly entryPoint: string;
}

/**
 * The bounded part of SelectedMaterialContext sent back to its owning Adapter.
 * The Adapter must match this identity before resolving final draw evidence.
 */
export interface VisualLabSelectionIdentity {
  readonly selectionId: string;
  /** Opaque Published LSP revision that owned the source Context selection. */
  readonly contextRevision: string;
  readonly material: MaterialContextAsset;
  readonly source: MaterialContextAsset;
  /** Optional Unity editor selection hint; never presented as runtime draw fact. */
  readonly selectedProgram?: MaterialContextProgram;
  /** Explicit user-selected source Context that owns this controlled preview. */
  readonly requestedContext: VisualLabRequestedShaderContext;
  /** Complete Material keyword facts, sorted by scope then name. */
  readonly materialKeywords: readonly MaterialContextKeyword[];
  readonly adapter: VisualLabAdapterIdentity;
}

/**
 * Identity of the state requested from Unity, excluding the per-request
 * generation. Every response repeats this envelope independently.
 */
export interface VisualLabRenderTarget {
  readonly selectionId: string;
  /** Exact Published LSP revision used to resolve the requested Context. */
  readonly contextRevision: string;
  /** Persistent Material identity and the exact serialized revision rendered. */
  readonly material: MaterialContextAsset;
  /** Persistent Shader identity and the exact saved source revision rendered. */
  readonly source: MaterialContextAsset;
  readonly shaderContext: VisualLabShaderContext;
  readonly pipeline: VisualLabPipelineIdentity;
  readonly profile: VisualLabGraphicsProfile;
  readonly colorSpace: VisualLabColorSpace;
  readonly adapter: VisualLabAdapterIdentity;
  /** Repository-owned deterministic camera/geometry/lighting input identity. */
  readonly renderInputId: string;
}

export interface VisualLabDescribeTargetRequest {
  readonly selection: VisualLabSelectionIdentity;
}

export interface VisualLabDescribeTargetResponse {
  readonly capability: typeof VISUAL_LAB_ADAPTER_FEATURE;
  readonly target: VisualLabRenderTarget;
}

/** One explicit Before or After capture request. */
export interface VisualLabRenderRequest {
  readonly slot: VisualLabSlot;
  /** Monotonically increasing within one language-server session. */
  readonly requestGeneration: number;
  readonly target: VisualLabRenderTarget;
}

export interface VisualLabPngImage {
  readonly mediaType: 'image/png';
  readonly encoding: 'base64';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly data: string;
}

/**
 * One byte per pixel in top-left, row-major order. A byte is 255 iff any
 * rendered channel is non-finite, otherwise 0. Pixels containing both classes
 * count as NaN (the renderer applies NaN-before-Infinity precedence), so
 * nanPixelCount + infinitePixelCount always equals maskedPixelCount.
 */
export interface VisualLabNanInfMask {
  readonly format: 'r8';
  readonly origin: 'top-left';
  readonly layout: 'row-major';
  readonly encoding: 'base64';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly data: string;
  readonly nanPixelCount: number;
  readonly infinitePixelCount: number;
  readonly maskedPixelCount: number;
}

/**
 * Adapter response for one request. Before and After are deliberately separate
 * responses: each frame owns complete evidence for the state it rendered.
 */
export interface VisualLabFrameEvidence {
  readonly capability: typeof VISUAL_LAB_ADAPTER_FEATURE;
  readonly slot: VisualLabSlot;
  readonly requestGeneration: number;
  readonly target: VisualLabRenderTarget;
  readonly capturedAt: number;
  readonly image: VisualLabPngImage;
  readonly diagnostic: {
    readonly nanInfMask: VisualLabNanInfMask;
  };
}

export type VisualLabStaleReason =
  | 'selection-changed'
  | 'material-changed'
  | 'material-revision-changed'
  | 'source-revision-changed'
  | 'shader-context-changed'
  | 'pipeline-changed'
  | 'profile-changed'
  | 'color-space-changed'
  | 'adapter-instance-changed'
  | 'render-input-changed'
  | 'adapter-disconnected'
  | 'domain-reloaded'
  | 'identity-changed';

export type VisualLabUnavailableReason =
  | 'no-adapter'
  | 'adapter-disconnected'
  | 'capability-unavailable'
  | 'context-unavailable'
  | 'no-selection'
  | 'target-description-unavailable'
  | 'invalid-target'
  | 'invalid-evidence';

export type VisualLabCaptureFailureReason =
  | 'source-unavailable'
  | 'render-failed'
  | 'invalid-evidence'
  | 'evidence-limit-exceeded'
  | 'identity-mismatch';

export interface VisualLabRetainedFrame {
  readonly status: 'current' | 'stale';
  readonly frame: VisualLabFrameEvidence;
  readonly staleReason?: VisualLabStaleReason;
}

export type VisualLabSlotState =
  | {
      readonly status: 'empty';
      readonly slot: VisualLabSlot;
    }
  | {
      readonly status: 'capturing';
      readonly slot: VisualLabSlot;
      readonly requestGeneration: number;
      readonly previous?: VisualLabRetainedFrame;
    }
  | {
      readonly status: 'current';
      readonly slot: VisualLabSlot;
      readonly frame: VisualLabFrameEvidence;
    }
  | {
      readonly status: 'stale';
      readonly slot: VisualLabSlot;
      readonly reason: VisualLabStaleReason;
      readonly frame: VisualLabFrameEvidence;
    }
  | {
      readonly status: 'failed';
      readonly slot: VisualLabSlot;
      readonly requestGeneration: number;
      readonly reason: VisualLabCaptureFailureReason;
      readonly previous?: VisualLabRetainedFrame;
    };

export type VisualLabSessionState =
  | {
      readonly status: 'available';
      readonly target: VisualLabRenderTarget;
      readonly before: VisualLabSlotState;
      readonly after: VisualLabSlotState;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: VisualLabUnavailableReason;
      /** Retained for explicit stale display; never an implicit new selection. */
      readonly pinnedTarget?: VisualLabRenderTarget;
      readonly before: VisualLabSlotState;
      readonly after: VisualLabSlotState;
    };

export interface VisualLabStateParams {
  readonly textDocument: { readonly uri: string };
}

export interface VisualLabCaptureParams extends VisualLabStateParams {
  readonly slot: VisualLabSlot;
}

export type VisualLabSelectTargetParams = VisualLabStateParams;

export interface VisualLabStateChangedParams {
  readonly textDocument: { readonly uri: string };
  readonly state: VisualLabSessionState;
}
