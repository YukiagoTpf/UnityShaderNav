import type {
  Range,
  ShaderLabBlock,
  ShaderLabMaterialCbufferEntry,
  ShaderLabMaterialFacts,
  ShaderLabMaterialFieldEntry,
  StructureResult,
} from '@unity-shader-nav/shared';
import {
  interpretShaderLabSource,
  type ShaderLabSourceInterpretation,
} from './sourceInterpretation';

const MACRO_START_RE = /^\s*CBUFFER_START\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/;
const MACRO_END_RE = /^\s*CBUFFER_END\b/;
const NATIVE_START_RE = /^\s*cbuffer\s+([A-Za-z_][A-Za-z0-9_]*)/;
const FIELD_RE = /^\s*((?:(?:const|row_major|column_major|volatile)\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^;>]+>)?)\s+([A-Za-z_][A-Za-z0-9_]*)(\s*\[[^\]]+\])?\s*(?::\s*packoffset\s*\(\s*([^)]*?)\s*\))?\s*;\s*$/;
const SRP_TAG_RE = /"RenderPipeline"\s*=\s*"(?:UniversalPipeline|UniversalRenderPipeline|HDRenderPipeline)"/;
const INCLUDE_RE = /^\s*#\s*include(?:_with_pragmas)?\s+["<][^">]+[">]/i;
const SRP_INCLUDE_RE = /^\s*#\s*include(?:_with_pragmas)?\s+["<][^">]*render-pipelines[^">]*[">]/i;

function range(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

function leadingWhitespace(text: string): string {
  return /^\s*/.exec(text)?.[0] ?? '';
}

function braceDelta(text: string): number {
  let delta = 0;
  for (const character of text) {
    if (character === '{') delta++;
    else if (character === '}') delta--;
  }
  return delta;
}

interface ActiveCbuffer {
  name: string;
  nameRange: Range;
  declarationRange: Range;
  style: 'macro' | 'native';
  blockIndex: number;
  blockKind: ShaderLabBlock['kind'];
  startIndent: string;
  fields: ShaderLabMaterialFieldEntry[];
  fieldIndent?: string;
  conditional: boolean;
  opaque: boolean;
  nativeOpened: boolean;
  nativeDepth: number;
}

function fieldAt(
  raw: string,
  code: string,
  line: number,
  conditional: boolean,
): ShaderLabMaterialFieldEntry | undefined {
  const match = FIELD_RE.exec(code);
  if (!match) return undefined;
  const type = `${match[1].replace(/\s+/g, ' ').trim()}${(match[3] ?? '').replace(/\s+/g, '')}`;
  const name = match[2];
  const nameStart = raw.indexOf(name, code.indexOf(match[0]));
  if (nameStart < 0) return undefined;
  return {
    name,
    type,
    packOffset: match[4]?.replace(/\s+/g, ''),
    nameRange: range(line, nameStart, nameStart + name.length),
    declarationRange: range(line, 0, raw.replace(/\s+$/, '').length),
    conditional,
  };
}

function finalized(
  active: ActiveCbuffer,
  insertionLine: number,
  complete: boolean,
): ShaderLabMaterialCbufferEntry {
  return {
    name: active.name,
    nameRange: active.nameRange,
    declarationRange: active.declarationRange,
    fields: active.fields,
    blockIndex: active.blockIndex,
    blockKind: active.blockKind,
    insertionPosition: { line: insertionLine, character: 0 },
    fieldIndent: active.fieldIndent ?? `${active.startIndent}    `,
    conditional: active.conditional,
    opaque: active.opaque,
    complete,
  };
}

export function scanShaderLabMaterialFacts(
  text: string,
  blocks: readonly ShaderLabBlock[],
  structure: StructureResult,
): ShaderLabMaterialFacts {
  return scanShaderLabMaterialFactsFromSource(
    interpretShaderLabSource(text),
    blocks,
    structure,
  );
}

export function scanShaderLabMaterialFactsFromSource(
  source: ShaderLabSourceInterpretation,
  blocks: readonly ShaderLabBlock[],
  structure: StructureResult,
): ShaderLabMaterialFacts {
  const lines = source.lines;
  const facts: ShaderLabMaterialFacts = {
    srpEvidence: false,
    subShaderCount: structure.shaders.reduce((count, shader) => (
      count + shader.children.filter((child) => child.kind === 'subshader').length
    ), 0),
    hasIncludes: false,
    lineEnding: source.lineEnding,
    cbuffers: [],
    programBlocks: blocks.map((block, blockIndex) => ({
      blockIndex,
      kind: block.kind,
      startLine: block.startLine,
      endLine: block.endLine,
      insertionPosition: { line: block.endLine, character: 0 },
      indent: leadingWhitespace(lines[block.startLine]?.raw ?? ''),
      unterminated: block.unterminated,
    })),
  };

  for (let line = 0; line < lines.length; line++) {
    if (SRP_TAG_RE.test(lines[line].code)) facts.srpEvidence = true;
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    let conditionalDepth = 0;
    let active: ActiveCbuffer | undefined;

    for (let line = block.contentStartLine; line <= block.contentEndLine; line++) {
      const raw = lines[line]?.raw ?? '';
      const code = lines[line]?.code ?? '';
      if (INCLUDE_RE.test(code)) facts.hasIncludes = true;
      if (SRP_INCLUDE_RE.test(code)) facts.srpEvidence = true;

      const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/.exec(code)?.[1];
      if (directive === 'endif') conditionalDepth = Math.max(0, conditionalDepth - 1);
      const conditional = conditionalDepth > 0 || directive === 'elif' || directive === 'else';

      if (!active) {
        const macro = MACRO_START_RE.exec(code);
        const native = macro ? null : NATIVE_START_RE.exec(code);
        const match = macro ?? native;
        if (match) {
          const name = match[1];
          const nameStart = raw.indexOf(name);
          const isNative = !!native;
          active = {
            name,
            nameRange: range(line, nameStart, nameStart + name.length),
            declarationRange: range(line, 0, raw.replace(/\s+$/, '').length),
            style: isNative ? 'native' : 'macro',
            blockIndex,
            blockKind: block.kind,
            startIndent: leadingWhitespace(raw),
            fields: [],
            fieldIndent: undefined,
            conditional,
            opaque: false,
            nativeOpened: isNative && code.includes('{'),
            nativeDepth: isNative ? braceDelta(code) : 0,
          };
          if (name === 'UnityPerMaterial') facts.srpEvidence = true;
          const trailing = code.slice(match.index + match[0].length).trim();
          if (trailing && trailing !== '{') active.opaque = true;
          if (isNative && active.nativeOpened && active.nativeDepth <= 0) {
            active.opaque = true;
            facts.cbuffers.push(finalized(active, line, true));
            active = undefined;
          }
        }
      } else {
        active.conditional ||= conditional || directive !== undefined;
        const field = fieldAt(raw, code, line, conditional);
        if (field) {
          active.fields.push(field);
          active.fieldIndent ??= leadingWhitespace(raw);
        }

        if (active.style === 'macro' && MACRO_END_RE.test(code)) {
          facts.cbuffers.push(finalized(active, line, true));
          active = undefined;
        } else if (active.style === 'native') {
          if (code.includes('{')) active.nativeOpened = true;
          active.nativeDepth += braceDelta(code);
          if (active.nativeOpened && active.nativeDepth <= 0) {
            facts.cbuffers.push(finalized(active, line, true));
            active = undefined;
          }
        }

        if (active && code.trim() !== '' && !field && directive === undefined) {
          const structuralNativeLine = active.style === 'native'
            && /^\s*[{};]+\s*$/.test(code);
          if (!structuralNativeLine) active.opaque = true;
        }
      }

      if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
        conditionalDepth++;
      }
    }

    if (active) facts.cbuffers.push(finalized(active, block.endLine, false));
  }

  return facts;
}
