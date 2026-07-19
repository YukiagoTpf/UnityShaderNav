import type { CompileProfile, CompileProfileUnavailableReason } from './adapter';
import type { Range } from './symbols';

export const PORTABILITY_TARGETS_REQUEST = 'unityShaderNav/portabilityTargets';
export const PORTABILITY_REPORT_REQUEST = 'unityShaderNav/portabilityReport';
export const SHOW_PORTABILITY_REPORT_COMMAND =
  'unityShaderNav.showPortabilityReport';

export const UNIVERSAL_RENDER_PIPELINE_PACKAGE =
  'com.unity.render-pipelines.universal';

export type PortabilityTarget =
  | {
      readonly kind: 'render-pipeline';
      readonly pipeline: 'universal';
    }
  | {
      readonly kind: 'graphics-profile';
      readonly profile: CompileProfile;
    };

export type PortabilityFindingCategory =
  | 'mechanical-change'
  | 'human-rewrite'
  | 'unsupported-semantic'
  | 'verification-requirement';

export type PortabilityFindingArea =
  | 'shaderlab'
  | 'include'
  | 'macro'
  | 'cbuffer'
  | 'pass-tag'
  | 'precision'
  | 'feature'
  | 'compiler';

export interface PortabilityPackageEvidence {
  readonly name: string;
  readonly version?: string;
  readonly source?: string;
  readonly official: boolean;
}

export interface PortabilityEnvironment {
  readonly unityVersion?: string;
  readonly renderPipelinePackage?: PortabilityPackageEvidence;
}

export interface PortabilityTextEdit {
  readonly range: Range;
  readonly newText: string;
}

export interface PortabilitySafeFix {
  readonly title: string;
  readonly edits: readonly PortabilityTextEdit[];
}

export interface PortabilityFinding {
  readonly id: string;
  readonly category: PortabilityFindingCategory;
  readonly area: PortabilityFindingArea;
  readonly title: string;
  readonly explanation: string;
  readonly range?: Range;
  /** Present only when every edit is mechanically proven for this exact source. */
  readonly safeFix?: PortabilitySafeFix;
}

export type PortabilityCompilerVerification =
  | { readonly status: 'required' }
  | {
      readonly status: 'passed' | 'failed';
      readonly profile: CompileProfile;
      readonly unityVersion: string;
      readonly durationMs: number;
      readonly warningCount: number;
      readonly errorCount: number;
    }
  | {
      readonly status: 'unavailable';
      readonly profile: CompileProfile;
      readonly reason: CompileProfileUnavailableReason | 'profile-not-supported';
    };

export interface PortabilityReport {
  readonly uri: string;
  readonly target: PortabilityTarget;
  readonly environment: PortabilityEnvironment;
  /** Static rewrites never establish rendered equivalence. */
  readonly equivalence: 'not-claimed';
  readonly compilerVerification: PortabilityCompilerVerification;
  readonly findings: readonly PortabilityFinding[];
}

export interface PortabilityTargetsParams {
  readonly textDocument: { readonly uri: string };
}

export interface PortabilityTargetOption {
  readonly target: PortabilityTarget;
  readonly label: string;
  readonly detail: string;
}

export interface PortabilityTargetsResult {
  readonly targets: readonly PortabilityTargetOption[];
}

export interface PortabilityReportParams {
  readonly textDocument: { readonly uri: string };
  readonly target: PortabilityTarget;
}
