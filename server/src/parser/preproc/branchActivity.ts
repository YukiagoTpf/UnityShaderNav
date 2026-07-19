import type { VariantContext } from '@unity-shader-nav/shared';
import { analyzeInactiveRegions } from './analyzeInactiveRegions';

/**
 * Returns true if the code at `line` (0-based) is inside an active branch given
 * the supplied VariantContext. A line is "inactive" only when it falls within a
 * region that `analyzeInactiveRegions` classifies as `reason: 'inactive'`
 * (i.e. provably FALSE in this context). Regions classified as `reason:
 * 'variant'` are treated as active — conservative fallback: a branch that might
 * be active must never be ruled out.
 *
 * When `context` is undefined, `analyzeInactiveRegions` produces no 'inactive'
 * regions for variant-gated branches (only 'variant'), so this returns true for
 * every line — byte-for-byte identical to the no-context behaviour.
 */
export function isLineActive(
  text: string,
  line: number,
  context?: VariantContext,
  isShaderLab = false,
): boolean {
  const regions = analyzeInactiveRegions(text, { isShaderLab, context });
  for (const r of regions) {
    if (r.reason === 'inactive' && r.range.start.line <= line && line <= r.range.end.line) {
      return false;
    }
  }
  return true;
}
