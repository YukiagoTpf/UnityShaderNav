import type { ShaderLabBlock } from '@unity-shader-nav/shared';
import { scanBlocks } from '../shaderlab/blockScanner';
import { stripComments } from './stripComments';

export type VariantPragmaFamily = 'multi_compile' | 'shader_feature';
export type VariantPragmaStage =
  | 'vertex'
  | 'fragment'
  | 'hull'
  | 'domain'
  | 'geometry'
  | 'raytracing';

export interface DeclaredVariantPragma {
  readonly line: number;
  readonly directive: string;
  readonly family: VariantPragmaFamily;
  readonly local: boolean;
  readonly stage?: VariantPragmaStage;
  /** Unique, named keyword options in source order. Blank placeholders are omitted. */
  readonly keywords: readonly string[];
  /** Single-keyword `shader_feature` has an implicit blank; underscore-only tokens add one explicitly. */
  readonly hasBlankOption: boolean;
  /** Cardinality of the normalized keyword set, including at most one blank option. */
  readonly multiplier: number;
  /** True when a named option or blank placeholder was repeated on this directive. */
  readonly duplicateOptions: boolean;
  /** True when the pragma is lexically nested in any preprocessor conditional. */
  readonly conditional: boolean;
}

export interface DeclaredVariantContribution {
  readonly pragma: DeclaredVariantPragma;
  /** Unity does not permit a duplicate keyword set in one program, so it contributes ×1 here. */
  readonly duplicateSet: boolean;
  readonly effectiveMultiplier: number;
}

export type DeclaredVariantProgramKind = 'document' | 'HLSLPROGRAM' | 'CGPROGRAM';

export interface DeclaredVariantProgramCost {
  readonly kind: DeclaredVariantProgramKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly contributions: readonly DeclaredVariantContribution[];
  readonly uniqueSetCount: number;
  readonly largestMultiplier: number;
  /** Exact integer arithmetic keeps the product safe beyond Number.MAX_SAFE_INTEGER. */
  readonly upperBound: bigint;
}

export interface DeclaredVariantCostAnalysis {
  readonly pragmas: readonly DeclaredVariantPragma[];
  readonly programs: readonly DeclaredVariantProgramCost[];
}

const PRAGMA_RE = /^#\s*pragma\s+([A-Za-z_]\w*)\b(.*)$/;
const DIRECTIVE_RE = /^(multi_compile|shader_feature)(?:_(local))?(?:_(vertex|fragment|hull|domain|geometry|raytracing))?$/;
const OPTION_RE = /^[A-Za-z_]\w*$/;
const CONDITIONAL_RE = /^#\s*(if|ifdef|ifndef|endif)\b/;

/**
 * Scan only explicit keyword-set directives. Unity's built-in `multi_compile_*`
 * shortcuts are intentionally outside this first static-cost slice because their
 * cardinality depends on compiler and render-pipeline behavior.
 */
export function scanDeclaredVariantPragmas(text: string): DeclaredVariantPragma[] {
  const pragmas: DeclaredVariantPragma[] = [];
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;
  let conditionalDepth = 0;

  for (let line = 0; line < lines.length; line++) {
    const stripped = stripComments(lines[line], inBlockComment);
    inBlockComment = stripped.inBlockComment;
    const code = stripped.code.trim();
    const conditional = CONDITIONAL_RE.exec(code)?.[1];
    if (conditional === 'endif') conditionalDepth = Math.max(0, conditionalDepth - 1);

    const pragma = parseVariantPragma(code, line, conditionalDepth > 0);
    if (pragma) pragmas.push(pragma);

    if (conditional === 'if' || conditional === 'ifdef' || conditional === 'ifndef') {
      conditionalDepth++;
    }
  }

  return pragmas;
}

export function analyzeDeclaredVariantCosts(
  text: string,
  isShaderLab: boolean,
): DeclaredVariantCostAnalysis {
  const scanned = scanDeclaredVariantPragmas(text);
  const lineCount = text.split(/\r?\n/).length;

  if (!isShaderLab) {
    return {
      pragmas: scanned,
      programs: [createProgramCost('document', 0, Math.max(0, lineCount - 1), scanned)],
    };
  }

  const { blocks } = scanBlocks(text);
  const blockForLine = new Map<number, ShaderLabBlock>();
  for (const block of blocks) {
    for (let line = block.contentStartLine; line <= block.contentEndLine; line++) {
      blockForLine.set(line, block);
    }
  }

  // A Unity-specific pragma is meaningful here only inside an embedded HLSL/CG
  // block. ShaderLab text and comments outside those blocks stay neutral.
  const pragmas = scanned.filter((pragma) => blockForLine.has(pragma.line));
  const sharedHlsl = pragmas.filter((pragma) => blockForLine.get(pragma.line)?.kind === 'HLSLINCLUDE');
  const sharedCg = pragmas.filter((pragma) => blockForLine.get(pragma.line)?.kind === 'CGINCLUDE');
  const programs: DeclaredVariantProgramCost[] = [];

  for (const block of blocks) {
    if (block.kind !== 'HLSLPROGRAM' && block.kind !== 'CGPROGRAM') continue;
    const local = pragmas.filter((pragma) => blockForLine.get(pragma.line) === block);
    const shared = block.kind === 'HLSLPROGRAM' ? sharedHlsl : sharedCg;
    const declarations = [...shared, ...local].sort((left, right) => left.line - right.line);
    programs.push(createProgramCost(
      block.kind,
      block.startLine,
      block.endLine,
      declarations,
    ));
  }

  return { pragmas, programs };
}

function parseVariantPragma(
  code: string,
  line: number,
  conditional: boolean,
): DeclaredVariantPragma | undefined {
  const pragma = PRAGMA_RE.exec(code);
  if (!pragma) return undefined;
  const directive = DIRECTIVE_RE.exec(pragma[1]);
  if (!directive) return undefined;

  const rawOptions = pragma[2].trim() === '' ? [] : pragma[2].trim().split(/\s+/);
  if (rawOptions.length === 0 || rawOptions.some((option) => !OPTION_RE.test(option))) {
    return undefined;
  }

  const family = directive[1] as VariantPragmaFamily;
  const keywords: string[] = [];
  const seenKeywords = new Set<string>();
  let explicitBlank = false;
  let duplicateOptions = false;

  for (const option of rawOptions) {
    if (/^_+$/.test(option)) {
      if (explicitBlank) duplicateOptions = true;
      explicitBlank = true;
      continue;
    }
    if (seenKeywords.has(option)) {
      duplicateOptions = true;
      continue;
    }
    seenKeywords.add(option);
    keywords.push(option);
  }

  const hasBlankOption = explicitBlank
    || (family === 'shader_feature' && keywords.length === 1);
  const multiplier = keywords.length + (hasBlankOption ? 1 : 0);
  if (multiplier === 0) return undefined;

  const stage = directive[3] as VariantPragmaStage | undefined;
  return {
    line,
    directive: pragma[1],
    family,
    local: directive[2] === 'local',
    ...(stage ? { stage } : {}),
    keywords,
    hasBlankOption,
    multiplier,
    duplicateOptions,
    conditional,
  };
}

function createProgramCost(
  kind: DeclaredVariantProgramKind,
  startLine: number,
  endLine: number,
  pragmas: readonly DeclaredVariantPragma[],
): DeclaredVariantProgramCost {
  const contributions: DeclaredVariantContribution[] = [];
  const seenSets = new Set<string>();
  let upperBound = 1n;
  let largestMultiplier = 1;

  for (const pragma of pragmas) {
    const key = keywordSetKey(pragma);
    const duplicateSet = seenSets.has(key);
    const effectiveMultiplier = duplicateSet ? 1 : pragma.multiplier;
    if (!duplicateSet) {
      seenSets.add(key);
      upperBound *= BigInt(effectiveMultiplier);
      largestMultiplier = Math.max(largestMultiplier, effectiveMultiplier);
    }
    contributions.push({ pragma, duplicateSet, effectiveMultiplier });
  }

  return {
    kind,
    startLine,
    endLine,
    contributions,
    uniqueSetCount: seenSets.size,
    largestMultiplier: seenSets.size === 0 ? 0 : largestMultiplier,
    upperBound,
  };
}

function keywordSetKey(pragma: DeclaredVariantPragma): string {
  return JSON.stringify([
    pragma.local,
    pragma.stage ?? null,
    pragma.hasBlankOption,
    [...pragma.keywords].sort(),
  ]);
}
