import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileIndex, ReferenceEntry, SymbolEntry } from '@unity-shader-nav/shared';
import type { MacroPatternTable } from '../../macros';
import { parseHlsl } from './parser';
import { collect } from './collector';
import { scanPragmaLines } from '../../macros/matcher';
import { scanIncludes } from '../include/lineScanner';
import { scanDefines } from '../preproc/scanDefines';
import { scanBlocks } from '../shaderlab/blockScanner';
import { scanProperties } from '../shaderlab/propertiesScanner';
import { scanStructure } from '../shaderlab/structureScanner';

const HLSL_EXTS = new Set(['.hlsl', '.cginc', '.hlslinc', '.compute']);

function extOf(uri: string): string {
  try {
    return extname(fileURLToPath(uri)).toLowerCase();
  } catch {
    return extname(uri).toLowerCase();
  }
}

function scanPragmas(
  blockText: string,
  lineOffset: number,
  table: MacroPatternTable,
  uri: string,
): ReferenceEntry[] {
  const refs: ReferenceEntry[] = [];
  for (const match of scanPragmaLines(blockText, table)) {
    refs.push({
      name: match.capturedName,
      context: 'pragma',
      location: {
        uri,
        range: {
          start: {
            line: match.nameRange.start.line + lineOffset,
            character: match.nameRange.start.character,
          },
          end: {
            line: match.nameRange.end.line + lineOffset,
            character: match.nameRange.end.character,
          },
        },
      },
    });
  }
  return refs;
}

function scanIncludeReferences(
  blockText: string,
  lineOffset: number,
  uri: string,
): ReferenceEntry[] {
  return scanIncludes(blockText).map((include) => ({
    name: include.path,
    context: 'include',
    location: {
      uri,
      range: {
        start: {
          line: include.pathRange.start.line + lineOffset,
          character: include.pathRange.start.character,
        },
        end: {
          line: include.pathRange.end.line + lineOffset,
          character: include.pathRange.end.character,
        },
      },
    },
  }));
}

function pushDefines(blockText: string, lineOffset: number, uri: string, dest: SymbolEntry[]): void {
  const defines = scanDefines(blockText);
  for (const define of defines) {
    dest.push({
      name: define.name,
      kind: 'macro',
      location: {
        uri,
        range: {
          start: {
            line: define.nameRange.start.line + lineOffset,
            character: define.nameRange.start.character,
          },
          end: {
            line: define.nameRange.end.line + lineOffset,
            character: define.nameRange.end.character,
          },
        },
      },
    });
  }
}

export async function indexFile(
  uri: string,
  text: string,
  table?: MacroPatternTable,
): Promise<FileIndex> {
  const ext = extOf(uri);
  if (HLSL_EXTS.has(ext)) {
    const tree = await parseHlsl(text);
    const idx = collect(tree.rootNode, text, uri, 0, table);
    idx.references.push(...scanIncludeReferences(text, 0, uri));
    pushDefines(text, 0, uri, idx.symbols);
    if (table) idx.references.push(...scanPragmas(text, 0, table, uri));
    return idx;
  }

  if (ext === '.shader') {
    const { blocks } = scanBlocks(text);
    const lines = text.split(/\r?\n/);

    const merged: FileIndex = { uri, symbols: [], references: [] };
    for (const block of blocks) {
      const blockText = lines
        .slice(block.contentStartLine, block.contentEndLine + 1)
        .join('\n');
      const tree = await parseHlsl(blockText);
      const part = collect(tree.rootNode, blockText, uri, block.contentStartLine, table);
      merged.symbols.push(...part.symbols);
      pushDefines(blockText, block.contentStartLine, uri, merged.symbols);
      merged.references.push(...part.references);
      merged.references.push(...scanIncludeReferences(blockText, block.contentStartLine, uri));
      if (table) {
        merged.references.push(...scanPragmas(blockText, block.contentStartLine, table, uri));
      }
    }
    merged.structure = scanStructure(text);
    const properties = scanProperties(text);
    if (properties.length > 0) merged.properties = properties;
    return merged;
  }

  return { uri, symbols: [], references: [] };
}
