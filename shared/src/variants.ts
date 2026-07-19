import type {
  AdapterSourceRevision,
  AdapterUnavailableReason,
} from './adapter';
import type { ShaderStage } from './structure';

/** Adapter capability that supplies bounded, aggregate Unity build evidence. */
export const VARIANT_BUILD_EVIDENCE_CAPABILITY = 'variant-build-evidence';

/** Pull request for the current document's declared/build Variant comparison. */
export const VARIANT_COMPARISON_REQUEST = 'unityShaderNav/variantComparison';

/** User command that presents the current document's Variant comparison report. */
export const SHOW_VARIANT_COMPARISON_COMMAND = 'unityShaderNav.showVariantComparison';

export type VariantBuildStatus = 'completed' | 'incomplete' | 'failed';

export type VariantMeasurementUnavailableReason =
  | 'not-collected'
  | 'build-failed'
  | 'unsupported';

/** One Unity-measured count. Absence is explicit and is never represented as zero. */
export type VariantMeasuredCount =
  | {
      readonly availability: 'available';
      /** Non-negative base-10 integer retained without JavaScript number rounding. */
      readonly count: string;
    }
  | {
      readonly availability: 'unavailable';
      readonly reason: VariantMeasurementUnavailableReason;
    };

/** Stable identity of one source-declared keyword family. Blank is represented separately. */
export interface VariantKeywordSetIdentity {
  /** Unique named options; underscore placeholders are omitted. */
  readonly keywords: readonly string[];
  readonly scope: 'global' | 'local';
  readonly stage?: ShaderStage;
  readonly hasBlankOption: boolean;
}

/** Aggregate Adapter evidence for one declared keyword family, never raw Variants. */
export interface VariantKeywordSetBuildEvidence extends VariantKeywordSetIdentity {
  readonly compileCandidates: VariantMeasuredCount;
  readonly kept: VariantMeasuredCount;
}

/** Shader Context dimensions owned by one Unity build observation. */
export interface VariantBuildContextEvidence {
  readonly shaderName: string;
  readonly subShaderIndex: number;
  readonly passIndex?: number;
  readonly passName?: string;
  readonly stage: ShaderStage;
  readonly graphicsApi: string;
  readonly compileCandidates: VariantMeasuredCount;
  readonly kept: VariantMeasuredCount;
  readonly keywordSets: readonly VariantKeywordSetBuildEvidence[];
}

export interface VariantBuildEvidenceProvenance {
  readonly capability: typeof VARIANT_BUILD_EVIDENCE_CAPABILITY;
  readonly projectId: string;
  readonly instanceId: string;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  /** Unity BuildTarget, which is the Context Matrix platform dimension. */
  readonly buildTarget: string;
  readonly collectedAt: number;
  readonly sourceRevision: AdapterSourceRevision;
}

export interface VariantBuildFailure {
  readonly phase: 'compilation' | 'stripping' | 'build';
  readonly message: string;
}

/**
 * Latest aggregate evidence for one saved Shader asset and one build target.
 * Incomplete and failed builds intentionally retain every validated partial row.
 */
export interface VariantBuildEvidence {
  readonly status: VariantBuildStatus;
  readonly provenance: VariantBuildEvidenceProvenance;
  readonly contexts: readonly VariantBuildContextEvidence[];
  readonly failure?: VariantBuildFailure;
}

export type VariantBuildEvidenceUnavailableReason =
  | AdapterUnavailableReason
  | 'capability-unavailable'
  | 'source-unavailable'
  | 'connection-changed'
  | 'source-drift'
  | 'evidence-limit-exceeded'
  | 'invalid-evidence';

export type VariantBuildEvidenceResult =
  | {
      readonly availability: 'available';
      readonly evidence: VariantBuildEvidence;
    }
  | {
      readonly availability: 'unavailable';
      readonly reason: VariantBuildEvidenceUnavailableReason;
    };

/** Explicit value for a Context dimension that static source cannot prove. */
export const UNKNOWN_VARIANT_CONTEXT_DIMENSION = 'UNKNOWN';

export type DeclaredVariantEvidence =
  | {
      readonly evidenceClass: 'declared';
      readonly basis: 'static-upper-bound' | 'static-set-multiplier';
      readonly availability: 'available';
      readonly count: string;
    }
  | {
      readonly evidenceClass: 'declared';
      readonly basis: 'static-upper-bound' | 'static-set-multiplier';
      readonly availability: 'unavailable';
      readonly reason: 'no-declared-context';
    };

export type VariantComparisonMeasurementUnavailableReason =
  | VariantBuildEvidenceUnavailableReason
  | VariantMeasurementUnavailableReason
  | 'no-matching-build-context';

export type CompileCandidateVariantEvidence =
  | {
      readonly evidenceClass: 'compile-candidates';
      readonly basis: 'unity-build';
      readonly availability: 'available';
      readonly count: string;
    }
  | {
      readonly evidenceClass: 'compile-candidates';
      readonly basis: 'unity-build';
      readonly availability: 'unavailable';
      readonly reason: VariantComparisonMeasurementUnavailableReason;
    };

export type KeptVariantEvidence =
  | {
      readonly evidenceClass: 'kept';
      readonly basis: 'unity-build';
      readonly availability: 'available';
      readonly count: string;
    }
  | {
      readonly evidenceClass: 'kept';
      readonly basis: 'unity-build';
      readonly availability: 'unavailable';
      readonly reason: VariantComparisonMeasurementUnavailableReason;
    };

export interface VariantComparisonContext {
  readonly shaderName: string;
  readonly subShaderIndex: number;
  readonly passIndex?: number;
  readonly passName?: string;
  readonly stage: ShaderStage;
  readonly buildTarget: string;
  readonly graphicsApi: string;
  /** Zero-based line of the source program marker, when statically known. */
  readonly sourceLine?: number;
}

export interface VariantKeywordSetComparison {
  readonly identity: VariantKeywordSetIdentity;
  readonly declared: DeclaredVariantEvidence;
  readonly compileCandidates: CompileCandidateVariantEvidence;
  readonly kept: KeptVariantEvidence;
  /** Signed exact difference; absent unless declared and kept are both available. */
  readonly declaredToKeptGap?: string;
}

export interface VariantContextComparison {
  readonly context: VariantComparisonContext;
  readonly declared: DeclaredVariantEvidence;
  readonly compileCandidates: CompileCandidateVariantEvidence;
  readonly kept: KeptVariantEvidence;
  /** Comparable gaps first, descending, followed by explicitly unavailable sets. */
  readonly keywordSets: readonly VariantKeywordSetComparison[];
}

export interface LargestDeclaredToKeptGap {
  readonly context: VariantComparisonContext;
  readonly keywordSet: VariantKeywordSetIdentity;
  readonly declaredCount: string;
  readonly keptCount: string;
  readonly gap: string;
}

export type VariantComparisonBuild =
  | {
      readonly availability: 'available';
      readonly status: VariantBuildStatus;
      readonly provenance: VariantBuildEvidenceProvenance;
      readonly failure?: VariantBuildFailure;
    }
  | {
      readonly availability: 'unavailable';
      readonly reason: VariantBuildEvidenceUnavailableReason;
    };

export interface VariantComparisonReport {
  readonly currentSource: {
    readonly uri: string;
    readonly contentHash: string;
  };
  readonly build: VariantComparisonBuild;
  readonly comparisons: readonly VariantContextComparison[];
  readonly largestDeclaredToKeptGaps: readonly LargestDeclaredToKeptGap[];
}

export interface VariantComparisonParams {
  readonly textDocument: { readonly uri: string };
}
