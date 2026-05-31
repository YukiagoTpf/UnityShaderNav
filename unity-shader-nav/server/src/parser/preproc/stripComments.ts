import { maskCommentsLine } from '../masking';

/**
 * Blank `//` line comments and `/* * /` block comments to spaces while keeping
 * string bodies intact and preserving every other byte / column width. Block
 * state is threaded through `inBlockComment`. Delegates to the shared masker
 * (`strings: 'preserve'`) so all preproc consumers (scanDefines,
 * scanVariantKeywords, analyzeInactiveRegions) agree on what counts as code.
 */
export function stripComments(
  lineText: string,
  inBlockComment: boolean,
): { code: string; inBlockComment: boolean } {
  return maskCommentsLine(lineText, inBlockComment, { strings: 'preserve' });
}
