import type { Range } from '@unity-shader-nav/shared';
import { BUILTIN_DECLARATION_MACROS } from '../../macros/builtin';
import { BUILTIN_ENTRIES } from '../../suggestions/builtins/catalog';
import { scanBlocks } from './blockScanner';

export type ShaderLabLexicalTokenType =
  | 'keyword'
  | 'property'
  | 'string'
  | 'type'
  | 'decorator'
  | 'number'
  | 'macro'
  | 'enumMember'
  | 'function';

export interface ShaderLabLexicalToken {
  range: Range;
  tokenType: ShaderLabLexicalTokenType;
}

const SHADERLAB_KEYWORDS = new Set([
  'Shader',
  'Properties',
  'SubShader',
  'Pass',
  'Tags',
  'Name',
  'LOD',
  'Blend',
  'Cull',
  'ZWrite',
  'ZTest',
  'Offset',
  'ColorMask',
  'Stencil',
  'HLSLPROGRAM',
  'ENDHLSL',
  'CGPROGRAM',
  'ENDCG',
  'HLSLINCLUDE',
  'CGINCLUDE',
]);

const PROPERTY_TYPES = new Set([
  '2D',
  '3D',
  'Cube',
  'Color',
  'Vector',
  'Float',
  'Range',
  'Int',
]);

const BUILTIN_TOKEN_TYPES = new Map<string, ShaderLabLexicalTokenType>(
  BUILTIN_ENTRIES.flatMap((entry): Array<[string, ShaderLabLexicalTokenType]> => {
    switch (entry.kind) {
      case 'function':
      case 'macro':
      case 'type':
        return [[entry.name, entry.kind]];
      case 'semantic':
        return [[entry.name, 'enumMember']];
      case 'keyword':
      case 'state':
        return [];
    }
  }),
);

for (const macro of BUILTIN_DECLARATION_MACROS) {
  BUILTIN_TOKEN_TYPES.set(macro.pattern.split('(')[0], 'macro');
}

const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const NUMBER_RE = /(?<![A-Za-z_])\d+(?:\.\d+)?(?![A-Za-z_])/g;
const STRING_RE = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
const SWIZZLE_RE = /\.(?:[xyzw]{1,4}|[rgba]{1,4})\b/g;

interface CommentState {
  inBlockComment: boolean;
}

function makeRange(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

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
      if (ch === '\\' && next !== undefined) {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
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

function keywordPattern(words: ReadonlySet<string>): RegExp {
  return new RegExp(`\\b(?:${[...words].sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
}

function tokenKey(token: ShaderLabLexicalToken): string {
  const { range } = token;
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
    token.tokenType,
  ].join(':');
}

export function scanShaderLabTokens(text: string): ShaderLabLexicalToken[] {
  const lines = text.split(/\r?\n/);
  const blocks = scanBlocks(text).blocks;
  const tokens: ShaderLabLexicalToken[] = [];
  const seen = new Set<string>();
  const commentState: CommentState = { inBlockComment: false };
  const shaderLabKeywordRe = keywordPattern(SHADERLAB_KEYWORDS);
  const propertyTypeRe = keywordPattern(PROPERTY_TYPES);
  let propertiesDepth = 0;
  let tagsDepth = 0;

  function push(line: number, start: number, end: number, tokenType: ShaderLabLexicalTokenType): void {
    if (end <= start) return;
    const token = { range: makeRange(line, start, end), tokenType };
    const key = tokenKey(token);
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(token);
  }

  function scanStrings(lineNo: number, code: string, tokenType: ShaderLabLexicalTokenType): void {
    for (const match of code.matchAll(STRING_RE)) {
      const value = match[1];
      const start = (match.index ?? 0) + 1;
      push(lineNo, start, start + value.length, tokenType);
    }
  }

  function scanProperties(lineNo: number, code: string): void {
    for (const match of code.matchAll(/\[\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1];
      const start = (match.index ?? 0) + match[0].indexOf(name);
      push(lineNo, start, start + name.length, 'decorator');
    }

    const propertyMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(code);
    if (propertyMatch) {
      const name = propertyMatch[1];
      const start = propertyMatch[0].indexOf(name);
      push(lineNo, start, start + name.length, 'property');
    }

    scanStrings(lineNo, code, 'string');

    for (const match of code.matchAll(propertyTypeRe)) {
      push(lineNo, match.index ?? 0, (match.index ?? 0) + match[0].length, 'type');
    }

    for (const match of code.matchAll(NUMBER_RE)) {
      push(lineNo, match.index ?? 0, (match.index ?? 0) + match[0].length, 'number');
    }
  }

  function scanTags(lineNo: number, code: string): void {
    for (const match of code.matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)) {
      const full = match[0];
      const key = match[1];
      const value = match[2];
      const base = match.index ?? 0;
      const keyStart = base + full.indexOf(`"${key}"`) + 1;
      const valueStart = base + full.indexOf(`"${value}"`, full.indexOf('=')) + 1;
      push(lineNo, keyStart, keyStart + key.length, 'property');
      push(lineNo, valueStart, valueStart + value.length, 'string');
    }
  }

  function scanHlslLexical(lineNo: number, code: string): void {
    const directive = /#\s*(include|pragma|define)\b/.exec(code);
    if (directive) {
      const start = directive.index;
      const end = start + directive[0].length;
      push(lineNo, start, end, 'keyword');

      if (directive[1] === 'include') {
        scanStrings(lineNo, code.slice(end), 'string');
        const offset = end;
        const last = tokens[tokens.length - 1];
        if (last && last.range.start.line === lineNo && last.range.start.character < offset) {
          tokens.pop();
          seen.delete(tokenKey(last));
        }
        for (const match of code.slice(end).matchAll(STRING_RE)) {
          const value = match[1];
          const valueStart = offset + (match.index ?? 0) + 1;
          push(lineNo, valueStart, valueStart + value.length, 'string');
        }
      } else if (directive[1] === 'define') {
        const defineName = /#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(code);
        if (defineName) {
          const name = defineName[1];
          const nameStart = (defineName.index ?? 0) + defineName[0].lastIndexOf(name);
          push(lineNo, nameStart, nameStart + name.length, 'macro');
        }
      }
    }

    for (const match of code.matchAll(WORD_RE)) {
      const tokenType = BUILTIN_TOKEN_TYPES.get(match[0]);
      if (!tokenType) continue;
      push(lineNo, match.index ?? 0, (match.index ?? 0) + match[0].length, tokenType);
    }

    for (const match of code.matchAll(SWIZZLE_RE)) {
      const start = (match.index ?? 0) + 1;
      push(lineNo, start, start + match[0].length - 1, 'property');
    }
  }

  function scanShaderLabKeywords(lineNo: number, code: string): void {
    for (const match of code.matchAll(shaderLabKeywordRe)) {
      push(lineNo, match.index ?? 0, (match.index ?? 0) + match[0].length, 'keyword');
    }
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const code = maskComments(lines[lineNo], commentState);
    const block = blocks.find((candidate) => (
      candidate.startLine <= lineNo && lineNo <= candidate.endLine
    ));
    const inHlslContent = block !== undefined
      && block.contentStartLine <= lineNo
      && lineNo <= block.contentEndLine;

    scanShaderLabKeywords(lineNo, code);

    if (inHlslContent) {
      scanHlslLexical(lineNo, code);
      continue;
    }

    const hasProperties = /\bProperties\b/.test(code);
    const hasTags = /\bTags\b/.test(code);
    const inProperties = propertiesDepth > 0 || hasProperties;
    const inTags = tagsDepth > 0 || hasTags;

    if (inTags) {
      scanTags(lineNo, code);
    } else if (inProperties) {
      scanProperties(lineNo, code);
    }

    if (hasProperties || propertiesDepth > 0) {
      propertiesDepth += countChar(code, '{') - countChar(code, '}');
      if (propertiesDepth < 0) propertiesDepth = 0;
    }
    if (hasTags || tagsDepth > 0) {
      tagsDepth += countChar(code, '{') - countChar(code, '}');
      if (tagsDepth < 0) tagsDepth = 0;
    }
  }

  return tokens.sort((a, b) => (
    a.range.start.line - b.range.start.line
    || a.range.start.character - b.range.start.character
    || a.range.end.character - b.range.end.character
  ));
}
