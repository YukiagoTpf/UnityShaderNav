import { stripComments } from './stripComments';

const VARIANT_PRAGMA_RE = /^#\s*pragma\s+(?:multi_compile\w*|shader_feature\w*)\s+(.*)$/;

/**
 * Scan Unity variant keywords declared by `#pragma multi_compile*` /
 * `#pragma shader_feature*` pragmas.
 *
 * Pragmas are declarations, so keywords are collected flow-insensitively across
 * the whole text. Comment-aware (handles `//` and `/* *​/`, including multi-line
 * block comments). The bare single underscore `_` (Unity's "feature off"
 * placeholder) is dropped; keywords that merely start with `_` (e.g. `_FOO`) are
 * kept.
 */
export function scanVariantKeywords(text: string): Set<string> {
  const lines = text.split(/\r?\n/);
  const out = new Set<string>();
  let inBlockComment = false;

  for (const raw of lines) {
    const stripped = stripComments(raw, inBlockComment);
    inBlockComment = stripped.inBlockComment;

    const match = VARIANT_PRAGMA_RE.exec(stripped.code.trim());
    if (!match) continue;

    const remainder = match[1];
    for (const token of remainder.split(/\s+/)) {
      if (token === '' || token === '_') continue;
      out.add(token);
    }
  }

  return out;
}
