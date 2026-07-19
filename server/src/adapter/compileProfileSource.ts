import type { CompileProfile } from '@unity-shader-nav/shared';

/**
 * Transport-neutral discovery boundary for compiler profiles exposed by the
 * currently connected Adapter. Tests inject deterministic version-specific
 * sources; no profile availability is inferred by the language server.
 */
export interface CompileProfileSource {
  getCompileProfiles(): Promise<readonly CompileProfile[]>;
}
