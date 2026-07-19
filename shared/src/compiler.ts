import type {
  AdapterSourceRevision,
  CompileProfile,
  CompileProfileUnavailableReason,
} from './adapter';
import type { Range } from './symbols';

/** Adapter capability that supplies compiler text plus trustworthy source identity. */
export const COMPILER_EVIDENCE_CAPABILITY = 'compiler-evidence';

/** Pull requests used by the client-owned virtual-document surface. */
export const COMPILER_PROFILES_REQUEST = 'unityShaderNav/compilerProfiles';
export const COMPILER_VIEWS_REQUEST = 'unityShaderNav/compilerViews';
export const COMPILER_VIRTUAL_DOCUMENT_REQUEST =
  'unityShaderNav/compilerVirtualDocument';
export const COMPILER_MAPPING_REQUEST = 'unityShaderNav/compilerMapping';
export const COMPILER_VIRTUAL_DOCUMENT_CHANGED_NOTIFICATION =
  'unityShaderNav/compilerVirtualDocumentChanged';

export const COMPILER_VIRTUAL_DOCUMENT_SCHEME = 'unity-shader-nav-compiler';

export const OPEN_SOURCE_VIEW_COMMAND = 'unityShaderNav.openShaderSource';
export const OPEN_PREPROCESSED_VIEW_COMMAND =
  'unityShaderNav.openPreprocessedShader';
export const OPEN_GENERATED_VIEW_COMMAND = 'unityShaderNav.openGeneratedShader';
export const GO_TO_SOURCE_MAPPING_COMMAND =
  'unityShaderNav.goToCompilerMappedSource';
export const GO_TO_PREPROCESSED_MAPPING_COMMAND =
  'unityShaderNav.goToPreprocessedMapping';
export const GO_TO_GENERATED_MAPPING_COMMAND =
  'unityShaderNav.goToGeneratedMapping';

export type CompilerDocumentKind = 'preprocessed' | 'generated';
export type CompilerViewKind = 'source' | CompilerDocumentKind;

/** Stable identity for any ShaderLab/HLSL/include snapshot used by a mapping. */
export interface CompilerSourceIdentity {
  readonly uri: string;
  /** Adapter-owned identity: an asset GUID, package identity, or built-in source ID. */
  readonly sourceId: string;
  /** SHA-256 of the exact UTF-8 source snapshot. */
  readonly contentHash: string;
}

/** One exact source snapshot and the names Unity emits for it in #line directives. */
export interface AdapterCompilerSourceSnapshot {
  readonly identity: CompilerSourceIdentity;
  readonly text: string;
  readonly lineDirectiveNames: readonly string[];
}

/** Compiler text captured without assuming that every line maps to source. */
export interface AdapterCompilerDocument {
  readonly kind: CompilerDocumentKind;
  readonly text: string;
  /** Exact file identity Unity may use in a compiler diagnostic. */
  readonly compilerPath?: string;
}

export interface CompilerEvidenceProvenance {
  readonly capability: typeof COMPILER_EVIDENCE_CAPABILITY;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly collectedAt: number;
  readonly sourceRevision: AdapterSourceRevision;
  readonly contextId: string;
  readonly profile: CompileProfile;
}

/** Transport payload. Mapping is derived only from exact #line + source text matches. */
export interface AdapterCompilerEvidence {
  readonly sources: readonly AdapterCompilerSourceSnapshot[];
  readonly documents: readonly AdapterCompilerDocument[];
  readonly provenance: CompilerEvidenceProvenance;
}

export type CompilerEvidenceUnavailableReason =
  | CompileProfileUnavailableReason
  | 'profile-not-supported'
  | 'capability-unavailable'
  | 'compiler-evidence-source-unavailable'
  | 'context-unavailable'
  | 'source-unavailable';

export type CompilerEvidenceRunResult =
  | {
      readonly status: 'available';
      readonly evidence: AdapterCompilerEvidence;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: CompilerEvidenceUnavailableReason;
    };

export type CompilerEvidenceStaleReason =
  | 'source-changed'
  | 'source-deleted'
  | 'source-hash-mismatch'
  | 'adapter-disconnected'
  | 'adapter-reconnected'
  | 'superseded';

export type CompilerUnmappedReason =
  | 'evidence-metadata'
  | 'line-directive'
  | 'generated-only'
  | 'macro-expansion'
  | 'unknown-source'
  | 'ambiguous-source'
  | 'invalid-source-line'
  | 'no-reliable-mapping';

export interface CompilerMappingProvenance {
  readonly method: 'line-directive' | 'compiler-reported-source';
  readonly granularity: 'line';
  readonly evidence: CompilerEvidenceProvenance;
  readonly directive?: {
    readonly documentLine: number;
    readonly sourceLine: number;
    readonly sourceName: string;
  };
}

export interface CompilerMappedLocation {
  readonly uri: string;
  readonly range: Range;
  /** Original source identity remains attached in both navigation directions. */
  readonly sourceIdentity: CompilerSourceIdentity;
  readonly provenance: CompilerMappingProvenance;
}

export interface CompilerProfilesParams {
  readonly textDocument: { readonly uri: string };
}

export interface CompilerViewsParams {
  readonly textDocument: { readonly uri: string };
  readonly profile: CompileProfile;
}

export interface CompilerVirtualView {
  readonly kind: CompilerDocumentKind;
  readonly uri: string;
}

export type CompilerViewsResult =
  | {
      readonly status: 'available';
      readonly evidenceId: string;
      readonly sourceUri: string;
      readonly contextId: string;
      readonly profile: CompileProfile;
      readonly stale: boolean;
      readonly staleReason?: CompilerEvidenceStaleReason;
      readonly views: readonly CompilerVirtualView[];
      readonly provenance: CompilerEvidenceProvenance;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: CompilerEvidenceUnavailableReason;
    };

export interface CompilerVirtualDocumentParams {
  readonly uri: string;
}

export type CompilerVirtualDocumentResult =
  | {
      readonly status: 'available';
      readonly content: string;
      readonly stale: boolean;
      readonly staleReason?: CompilerEvidenceStaleReason;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'evidence-unavailable';
    };

export interface CompilerMappingParams {
  readonly uri: string;
  readonly position: { readonly line: number; readonly character: number };
  readonly target: CompilerViewKind;
  /** Required when uri is an original file rather than a virtual document. */
  readonly evidenceId?: string;
}

export type CompilerMappingResult =
  | {
      readonly status: 'mapped';
      readonly evidenceId: string;
      readonly locations: readonly CompilerMappedLocation[];
    }
  | {
      readonly status: 'unmapped';
      readonly reason: CompilerUnmappedReason;
      readonly provenance: CompilerEvidenceProvenance;
    }
  | {
      readonly status: 'stale';
      readonly reason: CompilerEvidenceStaleReason;
      readonly provenance: CompilerEvidenceProvenance;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'evidence-unavailable' | 'target-unavailable';
    };

export interface CompilerVirtualDocumentChangedParams {
  readonly uris: readonly string[];
}
