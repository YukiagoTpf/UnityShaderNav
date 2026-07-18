import type {
  Range,
  ShaderLabBlock,
  ShaderLabMaterialCbufferEntry,
  ShaderLabMaterialFacts,
  ShaderLabMaterialFieldEntry,
  StructureResult,
} from '@unity-shader-nav/shared';
import { scanIncludeLine } from '../include/lineScanner';
import {
  interpretShaderLabSource,
  type ShaderLabSourceInterpretation,
} from './sourceInterpretation';

const MACRO_START_RE = /^\s*CBUFFER_START\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/;
const MACRO_END_RE = /^\s*CBUFFER_END\b/;
const NATIVE_START_RE = /^\s*cbuffer\s+([A-Za-z_][A-Za-z0-9_]*)/;
const DECLARATOR_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)((?:\s*\[[^\]]+\])*)\s*(?::\s*packoffset\s*\(\s*([^)]*?)\s*\))?\s*$/;
const SRP_TAG_RE = /"RenderPipeline"\s*=\s*"(?:UniversalPipeline|UniversalRenderPipeline|HDRenderPipeline)"/;
const TYPE_QUALIFIERS = new Set(['const', 'row_major', 'column_major', 'volatile']);

function range(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

function leadingWhitespace(text: string): string {
  return /^\s*/.exec(text)?.[0] ?? '';
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

interface OffsetRange {
  start: number;
  end: number;
}

interface FieldScan {
  fields: ShaderLabMaterialFieldEntry[];
  recognized: boolean;
}

function identifierEnd(text: string, start: number): number | undefined {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(start));
  return match ? start + match[0].length : undefined;
}

function splitTopLevel(
  text: string,
  start: number,
  end: number,
  separator: ',' | ';',
): OffsetRange[] | undefined {
  const ranges: OffsetRange[] = [];
  let itemStart = start;
  let angleDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let offset = start; offset < end; offset++) {
    switch (text[offset]) {
      case '<': angleDepth++; break;
      case '>':
        if (angleDepth === 0) return undefined;
        angleDepth--;
        break;
      case '[': bracketDepth++; break;
      case ']':
        if (bracketDepth === 0) return undefined;
        bracketDepth--;
        break;
      case '(': parenDepth++; break;
      case ')':
        if (parenDepth === 0) return undefined;
        parenDepth--;
        break;
      case '{':
      case '}':
        return undefined;
      default:
        break;
    }
    if (
      text[offset] === separator
      && angleDepth === 0
      && bracketDepth === 0
      && parenDepth === 0
    ) {
      ranges.push({ start: itemStart, end: offset });
      itemStart = offset + 1;
    }
  }

  if (angleDepth !== 0 || bracketDepth !== 0 || parenDepth !== 0) return undefined;
  ranges.push({ start: itemStart, end });
  return ranges;
}

function parseTypePrefix(
  code: string,
  start: number,
  end: number,
): { type: string; declaratorsStart: number } | undefined {
  let offset = start;
  while (offset < end && /\s/.test(code[offset])) offset++;
  const typeStart = offset;
  let typeEnd: number | undefined;

  while (offset < end) {
    const wordEnd = identifierEnd(code, offset);
    if (wordEnd === undefined) return undefined;
    const word = code.slice(offset, wordEnd);
    offset = wordEnd;
    if (!TYPE_QUALIFIERS.has(word)) {
      typeEnd = wordEnd;
      break;
    }
    const qualifierEnd = offset;
    while (offset < end && /\s/.test(code[offset])) offset++;
    if (offset === qualifierEnd) return undefined;
  }
  if (typeEnd === undefined) return undefined;

  const baseEnd = offset;
  while (offset < end && /\s/.test(code[offset])) offset++;
  if (code[offset] === '<') {
    let depth = 0;
    for (; offset < end; offset++) {
      if (code[offset] === '<') depth++;
      else if (code[offset] === '>') {
        depth--;
        if (depth === 0) {
          offset++;
          typeEnd = offset;
          break;
        }
      }
    }
    if (depth !== 0) return undefined;
  } else {
    offset = baseEnd;
  }

  const whitespaceStart = offset;
  while (offset < end && /\s/.test(code[offset])) offset++;
  if (offset === whitespaceStart) return undefined;
  return {
    type: code.slice(typeStart, typeEnd).replace(/\s+/g, ' ').trim(),
    declaratorsStart: offset,
  };
}

function parseFieldStatement(
  code: string,
  line: number,
  statement: OffsetRange,
  conditional: boolean,
): ShaderLabMaterialFieldEntry[] | undefined {
  const prefix = parseTypePrefix(code, statement.start, statement.end);
  if (!prefix) return undefined;
  const declarators = splitTopLevel(code, prefix.declaratorsStart, statement.end, ',');
  if (!declarators) return undefined;
  const declarationStart = statement.start + (/^\s*/.exec(code.slice(statement.start))?.[0].length ?? 0);
  const declarationEnd = statement.end - (/\s*$/.exec(code.slice(statement.start, statement.end))?.[0].length ?? 0);
  const fields: ShaderLabMaterialFieldEntry[] = [];

  for (const declarator of declarators) {
    const text = code.slice(declarator.start, declarator.end);
    const match = DECLARATOR_RE.exec(text);
    if (!match) return undefined;
    const name = match[1];
    const nameStart = declarator.start + (/^\s*/.exec(text)?.[0].length ?? 0);
    fields.push({
      name,
      type: `${prefix.type}${match[2].replace(/\s+/g, '')}`,
      packOffset: match[3]?.replace(/\s+/g, ''),
      nameRange: range(line, nameStart, nameStart + name.length),
      declarationRange: range(line, declarationStart, declarationEnd),
      conditional,
    });
  }
  return fields;
}

function scanFieldSegment(
  code: string,
  line: number,
  start: number,
  end: number,
  conditional: boolean,
): FieldScan {
  const statements = splitTopLevel(code, start, end, ';');
  if (!statements) return { fields: [], recognized: false };
  const fields: ShaderLabMaterialFieldEntry[] = [];

  for (let index = 0; index < statements.length - 1; index++) {
    const statement = statements[index];
    if (code.slice(statement.start, statement.end).trim() === '') {
      return { fields: [], recognized: false };
    }
    const parsed = parseFieldStatement(code, line, statement, conditional);
    if (!parsed) return { fields: [], recognized: false };
    fields.push(...parsed);
  }
  const trailing = statements.at(-1);
  if (trailing && code.slice(trailing.start, trailing.end).trim() !== '') {
    return { fields: [], recognized: false };
  }
  return { fields, recognized: true };
}

function appendFieldScan(
  active: ActiveCbuffer,
  scan: FieldScan,
  raw: string,
  captureIndent: boolean,
): void {
  if (!scan.recognized) active.opaque = true;
  if (scan.fields.length === 0) return;
  active.fields.push(...scan.fields);
  if (captureIndent) active.fieldIndent ??= leadingWhitespace(raw);
}

function scanNativeContent(
  active: ActiveCbuffer,
  raw: string,
  code: string,
  line: number,
  contentStart: number,
  conditional: boolean,
): boolean {
  const initialDepth = active.nativeDepth;
  let depth = initialDepth;
  let closingBrace = -1;
  for (let offset = contentStart; offset < code.length; offset++) {
    if (code[offset] === '{') depth++;
    else if (code[offset] === '}') {
      depth--;
      if (depth === 0) {
        closingBrace = offset;
        break;
      }
    }
  }

  const contentEnd = closingBrace >= 0 ? closingBrace : code.length;
  const scan = initialDepth === 1
    ? scanFieldSegment(code, line, contentStart, contentEnd, conditional)
    : { fields: [], recognized: false };
  appendFieldScan(active, scan, raw, contentStart === 0);
  active.nativeDepth = depth;
  if (closingBrace < 0) return false;
  if (!/^\s*;?\s*$/.test(code.slice(closingBrace + 1))) active.opaque = true;
  return true;
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
      const include = scanIncludeLine(code, line);
      if (include) {
        facts.hasIncludes = true;
        if (/render-pipelines/i.test(include.path)) facts.srpEvidence = true;
      }

      const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/.exec(code)?.[1];
      if (directive === 'endif') conditionalDepth = Math.max(0, conditionalDepth - 1);
      const conditional = conditionalDepth > 0 || directive === 'elif' || directive === 'else';

      if (!active) {
        const macro = MACRO_START_RE.exec(code);
        const native = macro ? null : NATIVE_START_RE.exec(code);
        const match = macro ?? native;
        if (match) {
          const name = match[1];
          const nameStart = match.index + match[0].lastIndexOf(name);
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
            nativeOpened: false,
            nativeDepth: 0,
          };
          if (name === 'UnityPerMaterial') facts.srpEvidence = true;
          const afterDeclaration = match.index + match[0].length;
          if (isNative) {
            const openingBrace = code.indexOf('{', afterDeclaration);
            if (openingBrace < 0) {
              if (code.slice(afterDeclaration).trim() !== '') active.opaque = true;
            } else {
              if (code.slice(afterDeclaration, openingBrace).trim() !== '') {
                active.opaque = true;
              }
              active.nativeOpened = true;
              active.nativeDepth = 1;
              if (scanNativeContent(
                active,
                raw,
                code,
                line,
                openingBrace + 1,
                conditional,
              )) {
                facts.cbuffers.push(finalized(active, line, true));
                active = undefined;
              }
            }
          } else if (code.slice(afterDeclaration).trim() !== '') {
            active.opaque = true;
          }
        }
      } else {
        active.conditional ||= conditional || directive !== undefined;
        if (active.style === 'macro') {
          if (MACRO_END_RE.test(code)) {
            facts.cbuffers.push(finalized(active, line, true));
            active = undefined;
          } else if (directive === undefined) {
            appendFieldScan(
              active,
              scanFieldSegment(code, line, 0, code.length, conditional),
              raw,
              true,
            );
          }
        } else if (directive === undefined) {
          if (!active.nativeOpened) {
            const openingBrace = code.indexOf('{');
            if (openingBrace < 0) {
              if (code.trim() !== '') active.opaque = true;
            } else {
              if (code.slice(0, openingBrace).trim() !== '') active.opaque = true;
              active.nativeOpened = true;
              active.nativeDepth = 1;
              if (scanNativeContent(
                active,
                raw,
                code,
                line,
                openingBrace + 1,
                conditional,
              )) {
                facts.cbuffers.push(finalized(active, line, true));
                active = undefined;
              }
            }
          } else if (scanNativeContent(active, raw, code, line, 0, conditional)) {
            facts.cbuffers.push(finalized(active, line, true));
            active = undefined;
          }
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
