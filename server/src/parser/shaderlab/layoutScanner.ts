import type {
  ShaderLabBlock,
  ShaderLabNodeKind,
  ShaderLabStructureNode,
  StructureResult,
} from '@unity-shader-nav/shared';
import { scanBlocksFromSource } from './blockScanner';
import {
  interpretShaderLabSource,
  type ShaderLabSourceInterpretation,
} from './sourceInterpretation';

export type ShaderLabScopeKind = ShaderLabNodeKind | 'properties';

export interface ShaderLabScope {
  readonly kind: ShaderLabScopeKind;
  readonly headerLine: number;
  readonly closeLine: number;
  readonly parent: ShaderLabScopeKind | undefined;
  readonly hasProgramBlock: boolean;
}

export interface ShaderLabLineLayout {
  readonly line: number;
  readonly indentDepth: number;
  readonly directScope: ShaderLabScopeKind | undefined;
  readonly protected: boolean;
  readonly code: boolean;
}

export interface ShaderLabLayoutAnalysis {
  readonly safe: boolean;
  readonly issues: readonly string[];
  readonly blocks: readonly ShaderLabBlock[];
  readonly scopes: readonly ShaderLabScope[];
  readonly lines: readonly ShaderLabLineLayout[];
  readonly structure: StructureResult;
}

type FrameKind = ShaderLabScopeKind | 'category' | 'other';

interface Frame {
  kind: FrameKind;
  headerLine: number;
  parent: ShaderLabScopeKind | undefined;
  scope?: MutableScope;
  node?: ShaderLabStructureNode;
}

interface MutableScope {
  kind: ShaderLabScopeKind;
  headerLine: number;
  closeLine: number;
  parent: ShaderLabScopeKind | undefined;
  hasProgramBlock: boolean;
}

interface PendingScope {
  kind: Exclude<FrameKind, 'other'>;
  headerLine: number;
  name?: string;
}

const START_TO_END: Record<string, string> = {
  HLSLPROGRAM: 'ENDHLSL',
  CGPROGRAM: 'ENDCG',
  HLSLINCLUDE: 'ENDHLSL',
  CGINCLUDE: 'ENDCG',
};
const END_DIRECTIVES = new Set(['ENDHLSL', 'ENDCG']);

export function scanShaderLabLayout(text: string): ShaderLabLayoutAnalysis {
  return scanShaderLabLayoutFromSource(interpretShaderLabSource(text));
}

export function scanShaderLabLayoutFromSource(
  source: ShaderLabSourceInterpretation,
): ShaderLabLayoutAnalysis {
  const sourceLines = source.lines;
  const blocks = scanBlocksFromSource(source).blocks;
  const issues = validateProgramDirectives(source);
  if (blocks.some((block) => block.unterminated)) issues.push('unterminated program block');

  const protectedLines = new Set<number>();
  for (const block of blocks) {
    // Preserve the legacy Outline projection for malformed unterminated blocks;
    // safety is already false, so authoring edits will still be refused.
    if (block.unterminated) continue;
    for (let line = block.startLine; line <= block.endLine; line++) protectedLines.add(line);
  }

  const stack: Frame[] = [];
  const scopes: MutableScope[] = [];
  const lines: ShaderLabLineLayout[] = [];
  const shaders: ShaderLabStructureNode[] = [];
  let pending: PendingScope | undefined;
  let shaderCount = 0;

  for (let lineNo = 0; lineNo < sourceLines.length; lineNo++) {
    if (protectedLines.has(lineNo)) {
      lines.push({
        line: lineNo,
        indentDepth: stack.length,
        directScope: directScope(stack),
        protected: true,
        code: false,
      });
      continue;
    }

    const sourceLine = sourceLines[lineNo];
    if (sourceLine.unterminatedString) issues.push(`unterminated string at line ${lineNo + 1}`);
    if (hasStrayCommentClose(sourceLine.raw, sourceLine.commentRoles)) {
      issues.push(`stray block-comment close at line ${lineNo + 1}`);
    }
    const structuralCode = sourceLine.stringBodyMaskedCode;
    const code = sourceLine.braceSafeCode;
    const trimmed = code.trim();
    const directive = scopeDirective(code, lineNo);
    const structuralOpenings = countStructuralOpenings(structuralCode);
    const accountedOpening = directive && directive.kind !== 'category' ? 1 : 0;
    if (structuralOpenings > accountedOpening) {
      issues.push(`ambiguous inline structure at line ${lineNo + 1}`);
    }
    const leadingClosures = countLeadingClosures(code);
    lines.push({
      line: lineNo,
      indentDepth: Math.max(0, stack.length - leadingClosures),
      directScope: directScope(stack),
      protected: false,
      code: trimmed.length > 0,
    });

    if (stack.length === 0 && trimmed && !directive && !pending
      && !trimmed.startsWith('}')) {
      issues.push(`unsupported top-level content at line ${lineNo + 1}`);
    }
    if (pending && trimmed && !trimmed.startsWith('{') && !directive) {
      issues.push(`missing opening brace for ${pending.kind} at line ${pending.headerLine + 1}`);
      pending = undefined;
    }

    const lineScope = directive ?? pending;
    let usedLineScope = false;
    for (const ch of code) {
      if (ch === '{') {
        const candidate = !usedLineScope ? lineScope : undefined;
        usedLineScope = true;
        const candidateKind = candidate?.kind ?? 'other';
        const parent = directRecognizedScope(stack);
        const parentValid = validParent(candidateKind, parent, stack.length);
        if (!parentValid) {
          issues.push(`invalid ${candidateKind} parent at line ${lineNo + 1}`);
        }
        const kind: FrameKind = parentValid ? candidateKind : 'other';
        const frame: Frame = {
          kind,
          headerLine: candidate?.headerLine ?? lineNo,
          parent,
        };
        if (kind !== 'other' && kind !== 'category') {
          const scope: MutableScope = {
            kind,
            headerLine: frame.headerLine,
            closeLine: frame.headerLine,
            parent,
            hasProgramBlock: false,
          };
          frame.scope = scope;
          scopes.push(scope);
          if (kind !== 'properties') {
            const node: ShaderLabStructureNode = {
              kind,
              name: candidate?.name,
              headerLine: frame.headerLine,
              closeLine: frame.headerLine,
              children: [],
            };
            frame.node = node;
            const parentNode = [...stack].reverse().find((entry) => entry.node)?.node;
            if (parentNode) parentNode.children.push(node);
            else if (kind === 'shader') shaders.push(node);
          }
          if (kind === 'shader') shaderCount++;
        } else if (stack.length === 0) {
          issues.push(`unowned top-level block at line ${lineNo + 1}`);
        }
        stack.push(frame);
      } else if (ch === '}') {
        const frame = stack.pop();
        if (!frame) {
          issues.push(`unmatched closing brace at line ${lineNo + 1}`);
          continue;
        }
        if (frame.scope) frame.scope.closeLine = lineNo;
        if (frame.node) frame.node.closeLine = lineNo;
      }
    }

    const inlineName = /\bName\s+"([^"]*)"/.exec(code)?.[1];
    if (inlineName !== undefined) {
      const pass = [...stack].reverse().find((entry) => entry.kind === 'pass' && entry.node);
      if (pass?.node) pass.node.name = inlineName;
    }

    if (usedLineScope) pending = undefined;
    else if (directive) pending = directive;
  }

  if (source.unterminatedBlockComment) issues.push('unterminated block comment');
  if (pending) issues.push(`missing opening brace for ${pending.kind} at line ${pending.headerLine + 1}`);
  if (stack.length > 0) issues.push('unclosed ShaderLab block');
  if (shaderCount !== 1) issues.push(`expected one top-level Shader, found ${shaderCount}`);

  for (const scope of scopes) {
    if (scope.kind !== 'pass') continue;
    scope.hasProgramBlock = blocks.some((block) => (
      (block.kind === 'HLSLPROGRAM' || block.kind === 'CGPROGRAM')
      && lines[block.startLine]?.directScope === 'pass'
      && scope.headerLine < block.startLine && block.endLine < scope.closeLine
    ));
  }

  for (const block of blocks) {
    if (block.unterminated) continue;
    const owner = lines[block.startLine]?.directScope;
    const ownerValid = block.kind === 'HLSLPROGRAM'
      ? owner === 'pass'
      : block.kind === 'CGPROGRAM'
        ? owner === 'pass' || owner === 'subshader'
        : owner === 'shader' || owner === 'subshader' || owner === 'pass';
    if (!ownerValid) {
      issues.push(`invalid ${block.kind} owner at line ${block.startLine + 1}`);
    }
  }

  return {
    safe: issues.length === 0,
    issues,
    blocks,
    scopes,
    lines,
    structure: { shaders },
  };
}

function scopeDirective(code: string, line: number): PendingScope | undefined {
  const shader = /^\s*Shader\s+"([^"]*)"/.exec(code);
  if (shader && /^\s*Shader\s+"[^"]*"\s*(?:\{|$)/.test(code)) {
    return { kind: 'shader', headerLine: line, name: shader[1] };
  }
  if (/^\s*Properties\s*(?:\{|$)/.test(code)) {
    return { kind: 'properties', headerLine: line };
  }
  if (/^\s*SubShader\s*(?:\{|$)/.test(code)) {
    return { kind: 'subshader', headerLine: line };
  }
  if (/^\s*Pass\s*(?:\{|$)/.test(code)) {
    return {
      kind: 'pass',
      headerLine: line,
      name: /\bName\s+"([^"]*)"/.exec(code)?.[1],
    };
  }
  if (/^\s*Category\s*(?:\{|$)/.test(code)) {
    return { kind: 'category', headerLine: line };
  }
  return undefined;
}

function validParent(kind: FrameKind, parent: ShaderLabScopeKind | undefined, depth: number): boolean {
  if (kind === 'other') return depth > 0;
  if (kind === 'category') return parent === 'shader';
  if (kind === 'shader') return depth === 0;
  if (kind === 'properties' || kind === 'subshader') return parent === 'shader';
  return parent === 'subshader';
}

function directRecognizedScope(stack: readonly Frame[]): ShaderLabScopeKind | undefined {
  for (let index = stack.length - 1; index >= 0; index--) {
    const kind = stack[index].kind;
    if (kind === 'category') continue;
    if (kind === 'other') return undefined;
    return kind;
  }
  return undefined;
}

function directScope(stack: readonly Frame[]): ShaderLabScopeKind | undefined {
  const frame = stack.at(-1);
  return frame?.kind === 'other' || frame?.kind === 'category' ? undefined : frame?.kind;
}

function hasStrayCommentClose(line: string, roles: readonly string[]): boolean {
  for (let index = 0; index + 1 < line.length; index++) {
    if (line[index] === '*' && line[index + 1] === '/'
      && roles[index] === 'code' && roles[index + 1] === 'code') return true;
  }
  return false;
}

function countLeadingClosures(code: string): number {
  let index = 0;
  while (index < code.length && /[ \t]/.test(code[index])) index++;
  let count = 0;
  while (code[index] === '}') {
    count++;
    index++;
    while (index < code.length && /[ \t]/.test(code[index])) index++;
  }
  return count;
}

function countStructuralOpenings(code: string): number {
  const matches = code.match(
    /\bShader\s+"[^"]*"\s*\{|\b(?:Properties|SubShader|Pass)\s*\{/g,
  );
  return matches?.length ?? 0;
}

function validateProgramDirectives(source: ShaderLabSourceInterpretation): string[] {
  const issues: string[] = [];
  let expectedEnd: string | undefined;
  for (let lineNo = 0; lineNo < source.lines.length; lineNo++) {
    const directive = source.lines[lineNo].code.trim();
    const markerHead = /^(HLSLPROGRAM|CGPROGRAM|HLSLINCLUDE|CGINCLUDE|ENDHLSL|ENDCG)\b/.exec(
      directive,
    )?.[1];
    if (markerHead && directive !== markerHead) {
      issues.push(`ambiguous ${markerHead} directive at line ${lineNo + 1}`);
      continue;
    }
    const end = START_TO_END[directive];
    if (end) {
      if (expectedEnd) issues.push(`nested program directive at line ${lineNo + 1}`);
      else expectedEnd = end;
      continue;
    }
    if (!END_DIRECTIVES.has(directive)) continue;
    if (!expectedEnd) issues.push(`stray ${directive} at line ${lineNo + 1}`);
    else if (directive !== expectedEnd) issues.push(`mismatched ${directive} at line ${lineNo + 1}`);
    else expectedEnd = undefined;
  }
  if (expectedEnd) issues.push(`missing ${expectedEnd}`);
  return issues;
}
