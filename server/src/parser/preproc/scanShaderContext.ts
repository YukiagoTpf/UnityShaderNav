import type {
  ShaderContextDirectiveEntry,
  ShaderContextSourceFacts,
  ShaderContextStageEntry,
  ShaderContextVariantPragmaEntry,
  ShaderLabBlock,
  ShaderLabStructureNode,
  ShaderProgramContextEntry,
  ShaderStage,
  StructureResult,
} from '@unity-shader-nav/shared';
import type { ExactSource } from '../../sourceLocation';
import { maskCommentsLine } from '../masking';
import { parseVariantPragma } from './declaredVariantCost';

const INCLUDE_RE = /^(\s*#\s*include(?:_with_pragmas)?\s+)(?:"([^"\n]+)"|<([^>\n]+)>)/i;
const MACRO_RE = /^\s*#\s*(define|undef)\s+([A-Za-z_]\w*)\b/;
const CONDITIONAL_RE = /^\s*#\s*(if|ifdef|ifndef|endif)\b/;
const STAGE_RE = /^\s*#\s*pragma\s+(vertex|fragment|geometry|hull|domain|surface|kernel|raytracing)\s+([A-Za-z_]\w*)\b(.*)$/;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;
const VARIANT_CONDITIONAL_RE = /^#\s*(if|ifdef|ifndef|endif)\b/;

interface BlockSlice {
  readonly startLine: number;
  readonly endLine: number;
  readonly blockIndex?: number;
}

interface SourceOwner {
  readonly shader: ShaderLabStructureNode;
  readonly shaderIndex: number;
  readonly subShader?: ShaderLabStructureNode;
  readonly subShaderIndex?: number;
  readonly pass?: ShaderLabStructureNode;
  readonly passIndex?: number;
}

/**
 * Capture the minimum source-order facts needed to derive include-point
 * Contexts from an immutable FileIndex. No filesystem or include resolution is
 * performed here; that remains revision-bound in the workspace layer.
 */
export function scanShaderContextSource(
  source: ExactSource,
  blocks?: readonly ShaderLabBlock[],
  structure?: StructureResult,
): ShaderContextSourceFacts {
  const slices: BlockSlice[] = blocks
    ? blocks.map((block, blockIndex) => ({
      startLine: block.contentStartLine,
      endLine: block.contentEndLine,
      blockIndex,
    }))
    : [{ startLine: 0, endLine: Math.max(0, source.sourceLines.length - 1) }];
  const directives = slices.flatMap((slice) => scanDirectives(source, slice));
  const variantPragmas = scanVariantPragmas(source, blocks);
  const programs = blocks && structure
    ? scanPrograms(source, blocks, structure)
    : undefined;

  return {
    directives,
    variantPragmas,
    ...(programs ? { programs } : {}),
  };
}

function scanDirectives(
  source: ExactSource,
  slice: BlockSlice,
): ShaderContextDirectiveEntry[] {
  const directives: ShaderContextDirectiveEntry[] = [];
  let inBlockComment = false;
  let conditionalDepth = 0;

  for (let line = slice.startLine; line <= slice.endLine; line++) {
    const raw = source.sourceLines[line] ?? '';
    const stripped = maskCommentsLine(raw, inBlockComment, { strings: 'preserve' });
    inBlockComment = stripped.inBlockComment;
    const code = stripped.code;
    const conditionalDirective = CONDITIONAL_RE.exec(code)?.[1];
    if (conditionalDirective === 'endif') {
      conditionalDepth = Math.max(0, conditionalDepth - 1);
    }
    const conditional = conditionalDepth > 0;

    const include = INCLUDE_RE.exec(code);
    if (include) {
      const name = include[2] ?? include[3];
      const startCharacter = code.indexOf(name, include[1].length);
      directives.push({
        kind: 'include',
        name,
        range: range(line, startCharacter, startCharacter + name.length),
        conditional,
        ...(slice.blockIndex !== undefined ? { blockIndex: slice.blockIndex } : {}),
      });
    } else {
      const macro = MACRO_RE.exec(code);
      if (macro) {
        const name = macro[2];
        const startCharacter = code.indexOf(name, macro.index + macro[0].length - name.length);
        directives.push({
          kind: macro[1] as 'define' | 'undef',
          name,
          range: range(line, startCharacter, startCharacter + name.length),
          conditional,
          ...(slice.blockIndex !== undefined ? { blockIndex: slice.blockIndex } : {}),
        });
      }
    }

    if (
      conditionalDirective === 'if'
      || conditionalDirective === 'ifdef'
      || conditionalDirective === 'ifndef'
    ) conditionalDepth++;
  }

  return directives;
}

function scanVariantPragmas(
  source: ExactSource,
  blocks: readonly ShaderLabBlock[] | undefined,
): ShaderContextVariantPragmaEntry[] {
  const blockIndexForLine = (line: number): number | undefined => {
    if (!blocks) return undefined;
    const index = blocks.findIndex((block) => (
      block.contentStartLine <= line && line <= block.contentEndLine
    ));
    return index >= 0 ? index : undefined;
  };

  const entries: ShaderContextVariantPragmaEntry[] = [];
  let inBlockComment = false;
  let conditionalDepth = 0;
  for (let line = 0; line < source.sourceLines.length; line++) {
    const stripped = maskCommentsLine(
      source.sourceLines[line],
      inBlockComment,
      { strings: 'preserve' },
    );
    inBlockComment = stripped.inBlockComment;
    const code = stripped.code.trim();
    const conditional = VARIANT_CONDITIONAL_RE.exec(code)?.[1];
    if (conditional === 'endif') conditionalDepth = Math.max(0, conditionalDepth - 1);
    const pragma = parseVariantPragma(code, line, conditionalDepth > 0);
    if (!pragma) {
      if (conditional === 'if' || conditional === 'ifdef' || conditional === 'ifndef') {
        conditionalDepth++;
      }
      continue;
    }
    const blockIndex = blockIndexForLine(pragma.line);
    if (!blocks || blockIndex !== undefined) {
      entries.push({
        keywords: [...pragma.keywords],
        ...(pragma.stage ? { stage: pragma.stage } : {}),
        conditional: pragma.conditional,
        ...(blockIndex !== undefined ? { blockIndex } : {}),
      });
    }
    if (conditional === 'if' || conditional === 'ifdef' || conditional === 'ifndef') {
      conditionalDepth++;
    }
  }
  return entries;
}

function scanPrograms(
  source: ExactSource,
  blocks: readonly ShaderLabBlock[],
  structure: StructureResult,
): ShaderProgramContextEntry[] {
  const owners = blocks.map((block) => ownerAt(structure, block.startLine));
  const programs: ShaderProgramContextEntry[] = [];

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (block.kind !== 'HLSLPROGRAM' && block.kind !== 'CGPROGRAM') continue;
    const owner = owners[blockIndex];
    if (!owner || !owner.shader.name || owner.subShaderIndex === undefined) continue;
    const stages = scanStages(source, block);
    if (stages.length === 0) continue;

    const sharedKind = block.kind === 'HLSLPROGRAM' ? 'HLSLINCLUDE' : 'CGINCLUDE';
    const sharedBlockIndices: number[] = [];
    for (let candidateIndex = 0; candidateIndex < blocks.length; candidateIndex++) {
      const candidate = blocks[candidateIndex];
      if (
        candidate.kind !== sharedKind
        || candidate.startLine >= block.startLine
        || !ownerContains(owners[candidateIndex], owner)
      ) continue;
      sharedBlockIndices.push(candidateIndex);
    }

    programs.push({
      blockIndex,
      shaderName: owner.shader.name,
      subShaderIndex: owner.subShaderIndex,
      ...(owner.passIndex !== undefined ? { passIndex: owner.passIndex } : {}),
      ...(owner.pass?.name ? { passName: owner.pass.name } : {}),
      stages,
      sharedBlockIndices,
    });
  }

  return programs;
}

function scanStages(source: ExactSource, block: ShaderLabBlock): ShaderContextStageEntry[] {
  const stages: ShaderContextStageEntry[] = [];
  let inBlockComment = false;
  for (let line = block.contentStartLine; line <= block.contentEndLine; line++) {
    const raw = source.sourceLines[line] ?? '';
    const stripped = maskCommentsLine(raw, inBlockComment, { strings: 'preserve' });
    inBlockComment = stripped.inBlockComment;
    const match = STAGE_RE.exec(stripped.code);
    if (!match) continue;
    const stage = match[1] as ShaderStage;
    const entryPoint = match[2];
    const defines = stage === 'kernel'
      ? match[3]
        .trim()
        .split(/\s+/)
        .map((token) => /^([A-Za-z_]\w*)(?:=.*)?$/.exec(token)?.[1])
        .filter((token): token is string => token !== undefined && IDENTIFIER_RE.test(token))
      : [];
    stages.push({
      stage,
      entryPoint,
      defines,
    });
  }
  return stages;
}

function ownerAt(structure: StructureResult, line: number): SourceOwner | undefined {
  for (let shaderIndex = 0; shaderIndex < structure.shaders.length; shaderIndex++) {
    const shader = structure.shaders[shaderIndex];
    if (!containsLine(shader, line)) continue;
    const subShaders = shader.children.filter((child) => child.kind === 'subshader');
    for (let subShaderIndex = 0; subShaderIndex < subShaders.length; subShaderIndex++) {
      const subShader = subShaders[subShaderIndex];
      if (!containsLine(subShader, line)) continue;
      const passes = subShader.children.filter((child) => child.kind === 'pass');
      const passIndex = passes.findIndex((pass) => containsLine(pass, line));
      return {
        shader,
        shaderIndex,
        subShader,
        subShaderIndex,
        ...(passIndex >= 0 ? { pass: passes[passIndex], passIndex } : {}),
      };
    }
    return { shader, shaderIndex };
  }
  return undefined;
}

function containsLine(node: ShaderLabStructureNode, line: number): boolean {
  return node.headerLine <= line && line <= node.closeLine;
}

function ownerContains(
  candidate: SourceOwner | undefined,
  program: SourceOwner,
): boolean {
  if (!candidate || candidate.shaderIndex !== program.shaderIndex) return false;
  if (
    candidate.subShaderIndex !== undefined
    && candidate.subShaderIndex !== program.subShaderIndex
  ) return false;
  return candidate.passIndex === undefined || candidate.passIndex === program.passIndex;
}

function range(line: number, start: number, end: number) {
  return {
    start: { line, character: Math.max(0, start) },
    end: { line, character: Math.max(0, end) },
  };
}
