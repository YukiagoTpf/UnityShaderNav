import type {
  Range,
  ShaderLabBlock,
  ShaderLabPropertyEntry,
} from '@unity-shader-nav/shared';
import { asShaderLabPropertyType } from '../../vocabulary';
import { scanBlocksFromSource } from './blockScanner';
import {
  interpretShaderLabSource,
  type ShaderLabSourceInterpretation,
} from './sourceInterpretation';

// Captures:
//   1: optional decorator run (e.g. "[NoScaleOffset] [HDR] ")
//   2: property identifier
//   3: display name (quote-stripped) - validated, not stored (design decision 7)
//   4: type token (e.g. "2D", "Range", "Color")
//   5: default literal - validated, not stored (design decision 7)
const PROPERTY_LINE_RE =
  /^\s*((?:\[[^\]]*\]\s*)*)([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*"([^"]*)"\s*,\s*([A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*\)\s*(?:=\s*(.+?))?\s*(?:\/\/.*)?$/;

export interface ShaderLabLiteralColorFact {
  readonly range: Range;
  readonly components: readonly [number, number, number, number];
  readonly hdr: boolean;
}

export interface ShaderLabPropertyFacts {
  readonly entries: readonly ShaderLabPropertyEntry[];
  readonly literalColors: readonly ShaderLabLiteralColorFact[];
}

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const COLOR_LITERAL_RE = new RegExp(
  `^\\(\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*\\)$`,
);

function makeRange(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
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
export function scanShaderLabPropertyFacts(
  text: string,
  /** Ordered, non-overlapping block facts for this exact source when already available. */
  knownBlocks?: readonly ShaderLabBlock[],
): ShaderLabPropertyFacts {
  return scanShaderLabPropertyFactsFromSource(
    interpretShaderLabSource(text),
    knownBlocks,
  );
}

export function scanShaderLabPropertyFactsFromSource(
  source: ShaderLabSourceInterpretation,
  knownBlocks?: readonly ShaderLabBlock[],
): ShaderLabPropertyFacts {
  const lines = source.lines;
  const blocks = knownBlocks ?? scanBlocksFromSource(source).blocks;
  const entries: ShaderLabPropertyEntry[] = [];
  const literalColors: ShaderLabLiteralColorFact[] = [];
  let propertiesDepth = 0;
  let blockIndex = 0;
  // Sticky flag: set when the `Properties` keyword is seen, cleared the first
  // time we count an opening brace into propertiesDepth. Lets us handle the
  // Unity-common `Properties\n{` style where the opening brace is on the line
  // after the keyword — without that flag, brace-counting is gated on
  // propertiesDepth > 0 and the standalone `{` line is skipped.
  let pendingPropertiesOpen = false;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo].raw;
    const masked = lines[lineNo].stringBodyMaskedCode;

    // Skip HLSL/CG content lines entirely (do not contribute to brace depth
    // either — HLSL braces belong to the HLSL block, not to Properties).
    while (blocks[blockIndex] && blocks[blockIndex].endLine < lineNo) blockIndex++;
    const block = blocks[blockIndex];
    const inHlslContent = block !== undefined
      && block.contentStartLine <= lineNo
      && lineNo <= block.contentEndLine;
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
        // with the identifier. The regex's outer `\s*` is NOT part of capture
        // group 1, so we must add the leading-whitespace width back in — else
        // an indented `[Toggle(_Foo)] _Foo …` would resolve to the `_Foo`
        // inside the decorator argument.
        const leadingWs = rawLine.match(/^\s*/)?.[0].length ?? 0;
        const searchFrom = leadingWs + decoratorRun.length;
        const nameStart = rawLine.indexOf(name, searchFrom);
        if (nameStart >= 0) {
          // Declaration range: column 0 through the last non-whitespace glyph
          // on the raw line. Slice-and-trim avoids miscounting a trailing
          // `\r` (CRLF) as a visible character.
          const trimmedEnd = rawLine.replace(/\s+$/, '').length;

          const type = asShaderLabPropertyType(typeToken);

          entries.push({
            name,
            nameRange: makeRange(lineNo, nameStart, nameStart + name.length),
            declarationRange: makeRange(lineNo, 0, trimmedEnd),
            type,
          });

          if (type === 'Color' && match[5]) {
            const literal = match[5].trim();
            const color = COLOR_LITERAL_RE.exec(literal);
            const equals = masked.indexOf('=', nameStart + name.length);
            const literalStart = equals >= 0 ? rawLine.indexOf(literal, equals + 1) : -1;
            if (color && literalStart >= 0) {
              const components = color.slice(1).map(Number) as unknown as
                [number, number, number, number];
              if (components.every(Number.isFinite)) {
                literalColors.push({
                  range: makeRange(lineNo, literalStart, literalStart + literal.length),
                  components,
                  hdr: /\[\s*HDR\s*\]/.test(decoratorRun),
                });
              }
            }
          }
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

  return { entries, literalColors };
}

/** Compatibility projection for index consumers. */
export function scanProperties(
  text: string,
  knownBlocks?: readonly ShaderLabBlock[],
): ShaderLabPropertyEntry[] {
  return [...scanShaderLabPropertyFacts(text, knownBlocks).entries];
}
