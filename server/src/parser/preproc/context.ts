import type { VariantContext } from '@unity-shader-nav/shared';

/**
 * Request-local preprocessor evidence. Include-point facts extend the existing
 * user-selected VariantContext without becoming index or cache state.
 */
export interface PreprocessorContext extends VariantContext {
  readonly definedMacros?: ReadonlySet<string>;
  readonly undefinedMacros?: ReadonlySet<string>;
  readonly variantKeywords?: ReadonlySet<string>;
}
