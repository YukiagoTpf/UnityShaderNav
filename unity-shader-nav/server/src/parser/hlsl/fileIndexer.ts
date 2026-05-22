import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileIndex, ReferenceEntry } from '@unity-shader-nav/shared';
import type { MacroPatternTable } from '../../macros';
import { parseHlsl } from './parser';
import { collect } from './collector';
import { matchPragmaLine } from '../../macros/matcher';
import { scanBlocks } from '../shaderlab/blockScanner';

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
  const lines = blockText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = matchPragmaLine(lines[i], i, table);
    if (!match) continue;
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

export async function indexFile(
  uri: string,
  text: string,
  table?: MacroPatternTable,
): Promise<FileIndex> {
  const ext = extOf(uri);
  if (HLSL_EXTS.has(ext)) {
    const tree = await parseHlsl(text);
    const idx = collect(tree.rootNode, text, uri, 0, table);
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
      merged.references.push(...part.references);
      if (table) {
        merged.references.push(...scanPragmas(blockText, block.contentStartLine, table, uri));
      }
    }
    return merged;
  }

  return { uri, symbols: [], references: [] };
}
