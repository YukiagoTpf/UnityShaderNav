import type { Range } from '@unity-shader-nav/shared';
import { scanBlocks } from '../shaderlab/blockScanner';
import { scanVariantKeywords } from './scanVariantKeywords';
import { stripComments } from './stripComments';
import { evalCondition, type CondKind, type CondValue } from './evalCondition';

export interface DimmedRegion {
  /** whole-line range covering the dimmed body */
  range: Range;
  reason: 'inactive' | 'variant';
}

export interface AnalyzeOptions {
  /** true for .shader (analyze only inside HLSL/CG blocks); false = whole file. */
  isShaderLab: boolean;
}

type ChainState = 'NONE_TAKEN' | 'DEFINITELY_TAKEN' | 'VARIANT_PENDING' | 'UNKNOWN_PENDING';

interface Frame {
  /** is the currently-open clause dimmed? */
  dimmed: boolean;
  /** reason for the current clause's dim (only meaningful when dimmed) */
  reason: 'inactive' | 'variant';
  /** the currently-open clause is *definitely* active */
  clauseDefinite: boolean;
  /** chain bookkeeping across clauses of this #if/#elif/#else group */
  state: ChainState;
  /** first body line (0-based, in the slice's local coordinates) of the current clause */
  bodyStart: number;
}

interface DirectiveInfo {
  /** opening / chain / closing / macro-state directive keyword */
  kind: 'open' | 'elif' | 'else' | 'endif' | 'macro';
  /** condition kind for evaluation (open → ifdef/ifndef/if; elif → elif) */
  condKind?: CondKind;
  /** raw expression / macro-name text after the directive */
  expr: string;
  /** for #define/#undef tracking */
  define?: { op: 'define' | 'undef'; name: string };
}

const DIRECTIVE_RE = /^#\s*(ifdef|ifndef|if|elif|else|endif|define|undef)\b\s*(.*)$/;

/**
 * Classify a stripped directive line. Returns null for non-preprocessor lines or
 * directives we do not care about (`#pragma`, `#include`, `#error`, plain code…).
 */
function classifyDirective(code: string): DirectiveInfo | null {
  const trimmed = code.trim();
  const m = DIRECTIVE_RE.exec(trimmed);
  if (!m) return null;
  const word = m[1];
  const rest = m[2] ?? '';

  switch (word) {
    case 'ifdef':
      return { kind: 'open', condKind: 'ifdef', expr: rest.trim() };
    case 'ifndef':
      return { kind: 'open', condKind: 'ifndef', expr: rest.trim() };
    case 'if':
      return { kind: 'open', condKind: 'if', expr: rest.trim() };
    case 'elif':
      return { kind: 'elif', condKind: 'elif', expr: rest.trim() };
    case 'else':
      return { kind: 'else', expr: '' };
    case 'endif':
      return { kind: 'endif', expr: '' };
    case 'define': {
      const name = /^([A-Za-z_]\w*)/.exec(rest.trim());
      return name ? { kind: 'macro', expr: '', define: { op: 'define', name: name[1] } } : null;
    }
    case 'undef': {
      const name = /^([A-Za-z_]\w*)/.exec(rest.trim());
      return name ? { kind: 'macro', expr: '', define: { op: 'undef', name: name[1] } } : null;
    }
    default:
      return null;
  }
}

/**
 * Is a directive an *opening* directive that increases nesting depth?
 * Used by the dimmed-body skip scan to track depth lexically.
 */
function isOpeningKeyword(code: string): boolean {
  const m = DIRECTIVE_RE.exec(code.trim());
  return !!m && (m[1] === 'ifdef' || m[1] === 'ifndef' || m[1] === 'if');
}

function isEndifKeyword(code: string): boolean {
  const m = DIRECTIVE_RE.exec(code.trim());
  return !!m && m[1] === 'endif';
}

function isElifOrElseKeyword(code: string): boolean {
  const m = DIRECTIVE_RE.exec(code.trim());
  return !!m && (m[1] === 'elif' || m[1] === 'else');
}

/** Result of analyzing one region (HLSL file or one shader block). */
interface RegionAnalysis {
  regions: DimmedRegion[];
  /** top-level definite defines/undefs accumulated (for include→program seeding) */
  topLevelDefined: Set<string>;
  topLevelUndefed: Set<string>;
}

/**
 * Analyze a contiguous block of lines (already stripped of any ShaderLab block
 * directives). `lineOffset` is added to every emitted line number so ranges land
 * in file coordinates. `variants` is the file-wide variant keyword set. `seedDefined`
 * / `seedUndefed` seed the definite macro state from preceding include blocks.
 */
function analyzeLines(
  lines: string[],
  lineOffset: number,
  variants: ReadonlySet<string>,
  seedDefined: ReadonlySet<string>,
  seedUndefed: ReadonlySet<string>,
): RegionAnalysis {
  const regions: DimmedRegion[] = [];
  const defined = new Set<string>(seedDefined);
  const undefed = new Set<string>(seedUndefed);

  const stack: Frame[] = [];
  // running count of open frames whose clauseDefinite === false
  let nonDefiniteOpen = 0;
  const definiteScope = (): boolean => nonDefiniteOpen === 0;

  // pre-strip comments line-by-line so directive detection is comment-aware
  const code: string[] = [];
  let inBlockComment = false;
  for (const raw of lines) {
    const r = stripComments(raw, inBlockComment);
    inBlockComment = r.inBlockComment;
    code.push(r.code);
  }

  const emit = (bodyStartLocal: number, bodyEndLocalExclusive: number, reason: 'inactive' | 'variant'): void => {
    // body is [bodyStartLocal, bodyEndLocalExclusive) in local coords; skip empty
    if (bodyEndLocalExclusive <= bodyStartLocal) return;
    regions.push({
      range: {
        start: { line: bodyStartLocal + lineOffset, character: 0 },
        end: { line: bodyEndLocalExclusive - 1 + lineOffset, character: 0 },
      },
      reason,
    });
  };

  const applyDefine = (info: DirectiveInfo): void => {
    if (!info.define) return;
    if (!definiteScope()) return;
    const { op, name } = info.define;
    if (op === 'define') {
      defined.add(name);
      undefed.delete(name);
    } else {
      undefed.add(name);
      defined.delete(name);
    }
  };

  /** push a frame, updating nonDefiniteOpen */
  const pushFrame = (frame: Frame): void => {
    stack.push(frame);
    if (!frame.clauseDefinite) nonDefiniteOpen++;
  };

  /** recompute nonDefiniteOpen contribution when a frame's clauseDefinite flips */
  const setClauseDefinite = (frame: Frame, value: boolean): void => {
    if (frame.clauseDefinite === value) return;
    if (frame.clauseDefinite) {
      // was definite, now not
      nonDefiniteOpen++;
    } else {
      nonDefiniteOpen--;
    }
    frame.clauseDefinite = value;
  };

  const popFrame = (): Frame | undefined => {
    const frame = stack.pop();
    if (frame && !frame.clauseDefinite) nonDefiniteOpen--;
    return frame;
  };

  // Apply the clause rule. Returns presentation for the opening clause.
  // Mutates `frame.state` / `frame.clauseDefinite` per the tables.
  const applyClauseRule = (
    frame: Frame,
    v: CondValue,
  ): { dimmed: boolean; reason: 'inactive' | 'variant' } => {
    switch (frame.state) {
      case 'DEFINITELY_TAKEN':
        setClauseDefinite(frame, false);
        return { dimmed: true, reason: 'inactive' };
      case 'VARIANT_PENDING':
        setClauseDefinite(frame, false);
        return { dimmed: true, reason: 'variant' };
      case 'UNKNOWN_PENDING':
        setClauseDefinite(frame, false);
        if (v === 'FALSE') return { dimmed: true, reason: 'inactive' };
        return { dimmed: false, reason: 'inactive' };
      case 'NONE_TAKEN':
      default:
        if (v === 'TRUE') {
          setClauseDefinite(frame, true);
          frame.state = 'DEFINITELY_TAKEN';
          return { dimmed: false, reason: 'inactive' };
        }
        if (v === 'FALSE') {
          setClauseDefinite(frame, false);
          // state stays NONE_TAKEN
          return { dimmed: true, reason: 'inactive' };
        }
        if (v === 'VARIANT') {
          setClauseDefinite(frame, false);
          frame.state = 'VARIANT_PENDING';
          return { dimmed: true, reason: 'variant' };
        }
        // UNKNOWN
        setClauseDefinite(frame, false);
        frame.state = 'UNKNOWN_PENDING';
        return { dimmed: false, reason: 'inactive' };
    }
  };

  // #else value derivation (no expression).
  const applyElseRule = (frame: Frame): { dimmed: boolean; reason: 'inactive' | 'variant' } => {
    switch (frame.state) {
      case 'DEFINITELY_TAKEN':
        setClauseDefinite(frame, false);
        return { dimmed: true, reason: 'inactive' };
      case 'VARIANT_PENDING':
        setClauseDefinite(frame, false);
        return { dimmed: true, reason: 'variant' };
      case 'UNKNOWN_PENDING':
        setClauseDefinite(frame, false);
        return { dimmed: false, reason: 'inactive' };
      case 'NONE_TAKEN':
      default:
        setClauseDefinite(frame, true);
        return { dimmed: false, reason: 'inactive' };
    }
  };

  /**
   * Skip a dimmed clause's body starting at `from` (the first body line, local
   * coords). Tracks nested #if/#endif depth so we stop at the matching-depth
   * sibling #elif/#else/#endif. Returns the index of that boundary directive (the
   * #elif/#else/#endif line) — i.e. the line that closes/continues the dimmed
   * clause. The body region is [from, boundaryIndex).
   */
  const skipDimmedBody = (from: number): number => {
    let depth = 0;
    let i = from;
    for (; i < code.length; i++) {
      const c = code[i];
      if (isOpeningKeyword(c)) {
        depth++;
      } else if (isEndifKeyword(c)) {
        if (depth === 0) return i; // matching-depth #endif closes the clause
        depth--;
      } else if (isElifOrElseKeyword(c)) {
        if (depth === 0) return i; // matching-depth sibling continues the chain
      }
    }
    return code.length; // unterminated: body runs to EOF
  };

  let i = 0;
  while (i < code.length) {
    const info = classifyDirective(code[i]);

    if (!info) {
      i++;
      continue;
    }

    if (info.define) {
      applyDefine(info);
      i++;
      continue;
    }

    if (info.kind === 'open') {
      // ancestor dimmed? (safety net — see Step 3 nesting rule)
      const ancestorDimmed = stack.some((f) => f.dimmed);
      const frame: Frame = {
        dimmed: false,
        reason: 'inactive',
        clauseDefinite: false,
        state: 'NONE_TAKEN',
        bodyStart: i + 1,
      };

      if (ancestorDimmed) {
        // inherit dimming from the ancestor; do not evaluate.
        frame.dimmed = true;
        frame.reason = 'inactive';
        pushFrame(frame);
        i++;
        continue;
      }

      // Push first (registering the initial non-definite contribution) so that
      // applyClauseRule's setClauseDefinite adjusts nonDefiniteOpen consistently.
      pushFrame(frame);
      const v = evalCondition(info.condKind!, info.expr, { defined, undefed, variants });
      const pres = applyClauseRule(frame, v);
      frame.dimmed = pres.dimmed;
      frame.reason = pres.reason;

      if (pres.dimmed) {
        // emit the whole body as one region; skip lexically to matching boundary
        const boundary = skipDimmedBody(i + 1);
        emit(i + 1, boundary, pres.reason);
        i = boundary; // resume at the #elif/#else/#endif boundary directive
        continue;
      }

      i++;
      continue;
    }

    if (info.kind === 'elif' || info.kind === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) {
        // stray #elif/#else with no open frame — ignore
        i++;
        continue;
      }

      // If this chain is dimmed because an ancestor is dimmed, keep dimming.
      const ancestorDimmed = stack.slice(0, -1).some((f) => f.dimmed);

      let pres: { dimmed: boolean; reason: 'inactive' | 'variant' };
      if (ancestorDimmed) {
        setClauseDefinite(frame, false);
        pres = { dimmed: true, reason: 'inactive' };
      } else if (info.kind === 'else') {
        pres = applyElseRule(frame);
      } else {
        const v = evalCondition('elif', info.expr, { defined, undefed, variants });
        pres = applyClauseRule(frame, v);
      }

      frame.dimmed = pres.dimmed;
      frame.reason = pres.reason;
      frame.bodyStart = i + 1;

      if (pres.dimmed) {
        const boundary = skipDimmedBody(i + 1);
        emit(i + 1, boundary, pres.reason);
        i = boundary;
        continue;
      }

      i++;
      continue;
    }

    // info.kind === 'endif'
    popFrame();
    i++;
    continue;
  }

  // Collect top-level definite defines/undefs for include→program seeding.
  // After walking, `defined`/`undefed` only ever mutated under definiteScope, so
  // they already reflect the top-level definite state (any clause that was open at
  // EOF was unterminated and we treat its accumulated state as the result).
  return {
    regions,
    topLevelDefined: defined,
    topLevelUndefed: undefed,
  };
}

export function analyzeInactiveRegions(text: string, options: AnalyzeOptions): DimmedRegion[] {
  const lines = text.split(/\r?\n/);

  if (!options.isShaderLab) {
    const variants = scanVariantKeywords(text);
    return analyzeLines(lines, 0, variants, new Set(), new Set()).regions;
  }

  // .shader: variants are file-wide; program blocks seed from preceding includes.
  const variants = scanVariantKeywords(text);
  const { blocks } = scanBlocks(text);

  const regions: DimmedRegion[] = [];
  // shared base accumulated from include blocks (definite top-level defines)
  const baseDefined = new Set<string>();
  const baseUndefed = new Set<string>();

  for (const block of blocks) {
    if (block.contentEndLine < block.contentStartLine) continue; // empty body
    const bodyLines = lines.slice(block.contentStartLine, block.contentEndLine + 1);

    const isInclude = block.kind === 'HLSLINCLUDE' || block.kind === 'CGINCLUDE';

    const analysis = analyzeLines(bodyLines, block.contentStartLine, variants, baseDefined, baseUndefed);
    regions.push(...analysis.regions);

    if (isInclude) {
      // Fold this include's top-level definite defines into the shared base.
      // The analysis seeded from the base, so topLevelDefined/Undefed already
      // include the base plus this block's own definite mutations.
      for (const name of analysis.topLevelDefined) {
        baseDefined.add(name);
        baseUndefed.delete(name);
      }
      for (const name of analysis.topLevelUndefed) {
        baseUndefed.add(name);
        baseDefined.delete(name);
      }
    }
    // Program blocks do NOT mutate the shared base (no cross-pass leak).
  }

  return regions;
}
