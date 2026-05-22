import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileIndex } from '@unity-shader-nav/shared';
import { parseHlsl } from './parser';
import { collect } from './collector';
import { scanBlocks } from '../shaderlab/blockScanner';

const HLSL_EXTS = new Set(['.hlsl', '.cginc', '.hlslinc', '.compute']);

function extOf(uri: string): string {
  try {
    return extname(fileURLToPath(uri)).toLowerCase();
  } catch {
    return extname(uri).toLowerCase();
  }
}

/**
 * @param table  Reserved for Plan 05 (MacroPatternTable). Plan 03 ignores it;
 *               Plan 05 will fill in macro-driven symbol/pragma recognition.
 *               Declared optional here so Plan 05 doesn't change the signature
 *               (B5 防护).
 */
export async function indexFile(
  uri: string,
  text: string,
  _table?: unknown,
): Promise<FileIndex> {
  const ext = extOf(uri);
  if (HLSL_EXTS.has(ext)) {
    const tree = await parseHlsl(text);
    return collect(tree.rootNode, text, uri, 0);
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
      const part = collect(tree.rootNode, blockText, uri, block.contentStartLine);
      merged.symbols.push(...part.symbols);
      merged.references.push(...part.references);
    }
    return merged;
  }

  return { uri, symbols: [], references: [] };
}
