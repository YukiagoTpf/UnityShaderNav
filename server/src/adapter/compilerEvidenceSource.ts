import type {
  AdapterCompilerEvidence,
  CompileProfile,
  IncludePointContext,
} from '@unity-shader-nav/shared';

/**
 * Transport-neutral boundary for one Context-scoped compiler evidence request.
 * The Adapter, not the language server, decides how Unity produces the texts.
 */
export interface CompilerEvidenceSource {
  getCompilerEvidence(
    context: IncludePointContext,
    profile: CompileProfile,
  ): Promise<AdapterCompilerEvidence>;
}
