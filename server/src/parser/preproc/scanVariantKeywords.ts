import { scanDeclaredVariantPragmas } from './declaredVariantCost';

/**
 * Scan Unity variant keywords declared by `#pragma multi_compile*` /
 * `#pragma shader_feature*` pragmas.
 *
 * Pragmas are declarations, so keywords are collected flow-insensitively across
 * the whole text. Comment-aware (handles `//` and `/* *​/`, including multi-line
 * block comments). Every underscore-only placeholder is dropped; keywords that
 * merely start with `_` (for example `_FOO`) are kept.
 */
export function scanVariantKeywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const pragma of scanDeclaredVariantPragmas(text)) {
    for (const keyword of pragma.keywords) out.add(keyword);
  }
  return out;
}
