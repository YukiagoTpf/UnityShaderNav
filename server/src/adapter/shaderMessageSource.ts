import type {
  AdapterDiagnostic,
  CompileProfile,
} from '@unity-shader-nav/shared';

/**
 * Transport-neutral boundary for one bounded current-asset message refresh.
 * The real Unity Editor transport can implement this without entering LSP
 * handlers; tests inject a deterministic source directly.
 */
export interface ShaderMessageSource {
  getShaderMessages(
    documentUri: string,
    profile: CompileProfile,
    cancellation?: AbortSignal,
  ): Promise<readonly AdapterDiagnostic[]>;
}
