import type { Range, ShaderLabPropertyEntry, ShaderLabPropertyType } from '@unity-shader-nav/shared';
import { scanBlocks } from './blockScanner';

const PROPERTY_TYPES = new Set<ShaderLabPropertyType>([
  '2D',
  '3D',
  'Cube',
  'CubeArray',
  'Color',
  'Vector',
  'Float',
  'Range',
  'Int',
]);

// Captures:
//   1: optional decorator run (e.g. "[NoScaleOffset] [HDR] ")
//   2: property identifier
//   3: display name (quote-stripped) - validated, not stored (design decision 7)
//   4: type token (e.g. "2D", "Range", "Color")
//   5: default literal - validated, not stored (design decision 7)
const PROPERTY_LINE_RE =
  /^\s*((?:\[[^\]]*\]\s*)*)([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*,\s*([A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*\)\s*(?:=\s*(.+?))?\s*(?:\/\/.*)?$/;

interface CommentState {
  inBlockComment: boolean;
}

function makeRange(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

/**
 * Replace `//` and `/* * /` runs with spaces while preserving original column
 * widths. Mirrors `tokenScanner.maskComments` byte-for-byte so the property
 * scanner agrees with semantic highlighting on what counts as code.
 */
function maskComments(line: string, state: CommentState): string {
  const chars = line.split('');
  let inString = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (state.inBlockComment) {
      chars[i] = ' ';
      if (ch === '*' && next === '/') {
        chars[i + 1] = ' ';
        i++;
        state.inBlockComment = false;
      }
      continue;
    }

    if (inString) {
      // Blank every byte of the string body so that string literals can never
      // contribute `Properties` keyword matches or `{`/`}` to the brace
      // counter. Honor `\` escapes: a backslash consumes the next char.
      if (ch === '\\' && next !== undefined) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i++;
        continue;
      }
      if (ch === '"') {
        // Restore the closing quote so PROPERTY_LINE_RE (which anchors on
        // `"..."` for display names and default literals) still sees a pair
        // of delimiters around the now-blanked body.
        inString = false;
      } else {
        chars[i] = ' ';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      for (let j = i; j < chars.length; j++) chars[j] = ' ';
      break;
    }

    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i++;
      state.inBlockComment = true;
      continue;
    }

    if (ch === '"') inString = true;
  }

  return chars.join('');
}

function countChar(text: string, ch: string): number {
  let count = 0;
  for (const c of text) {
    if (c === ch) count++;
  }
  return count;
}

/**
 * Scan all Properties blocks in a .shader source and return one entry per
 * property declaration. Comment- and string-aware; HLSL/CG block ranges are
 * skipped. Never throws.
 */
export function scanProperties(text: string): ShaderLabPropertyEntry[] {
  const lines = text.split(/\r?\n/);
  const blocks = scanBlocks(text).blocks;
  const entries: ShaderLabPropertyEntry[] = [];
  const commentState: CommentState = { inBlockComment: false };
  let propertiesDepth = 0;
  // Sticky flag: set when the `Properties` keyword is seen, cleared the first
  // time we count an opening brace into propertiesDepth. Lets us handle the
  // Unity-common `Properties\n{` style where the opening brace is on the line
  // after the keyword — without that flag, brace-counting is gated on
  // propertiesDepth > 0 and the standalone `{` line is skipped.
  let pendingPropertiesOpen = false;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    const masked = maskComments(rawLine, commentState);

    // Skip HLSL/CG content lines entirely (do not contribute to brace depth
    // either — HLSL braces belong to the HLSL block, not to Properties).
    const inHlslContent = blocks.some(
      (b) => b.contentStartLine <= lineNo && lineNo <= b.contentEndLine,
    );
    if (inHlslContent) continue;

    const hasProperties = /\bProperties\b/.test(masked);
    if (hasProperties) pendingPropertiesOpen = true;

    if (propertiesDepth > 0) {
      const match = PROPERTY_LINE_RE.exec(masked);
      if (match) {
        const decoratorRun = match[1] ?? '';
        const name = match[2];
        const typeToken = match[4];

        // Locate the name in the raw line starting AFTER the decorator run, so
        // we never collide with a decorator that happens to share characters
        // with the identifier.
        const searchFrom = decoratorRun.length;
        const nameStart = rawLine.indexOf(name, searchFrom);
        if (nameStart >= 0) {
          // Declaration range: column 0 through the last non-whitespace glyph
          // on the raw line. Slice-and-trim avoids miscounting a trailing
          // `\r` (CRLF) as a visible character.
          const trimmedEnd = rawLine.replace(/\s+$/, '').length;

          const type: ShaderLabPropertyType | null =
            (PROPERTY_TYPES as Set<string>).has(typeToken)
              ? (typeToken as ShaderLabPropertyType)
              : null;

          entries.push({
            name,
            nameRange: makeRange(lineNo, nameStart, nameStart + name.length),
            declarationRange: makeRange(lineNo, 0, trimmedEnd),
            type,
          });
        }
      }
    }

    if (pendingPropertiesOpen || propertiesDepth > 0) {
      const opens = countChar(masked, '{');
      const closes = countChar(masked, '}');
      propertiesDepth += opens - closes;
      if (opens > 0) pendingPropertiesOpen = false;
      if (propertiesDepth < 0) propertiesDepth = 0;
    }
  }

  return entries;
}

