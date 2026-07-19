import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Parser from 'web-tree-sitter';
import type { FileIndex, ReferenceEntry, SymbolEntry } from '@unity-shader-nav/shared';
import {
  analysisMatchesSource,
  analyzeDocument,
  type DocumentAnalysis,
} from '../../analysis';
import type { MacroPatternRecognizer } from '../../macros';
import { exactSource, type ExactSource } from '../../sourceLocation';
import {
  createHlslParser,
  stabilizeHlslSource,
  type HlslParserFactory,
} from './parser';
import type { LiveDocumentTreeSession } from './liveDocumentTreeSession';
import { collect } from './collector';
import { scanIncludes } from '../include/lineScanner';
import { scanDefines } from '../preproc/scanDefines';
import { scanShaderContextSource } from '../preproc/scanShaderContext';

const HLSL_EXTS = new Set(['.hlsl', '.cginc', '.hlslinc', '.compute']);

function extOf(uri: string): string {
  try {
    return extname(fileURLToPath(uri)).toLowerCase();
  } catch {
    return extname(uri).toLowerCase();
  }
}

function scanPragmas(
  source: string | ExactSource,
  lineOffset: number,
  recognizer: MacroPatternRecognizer,
  uri: string,
): ReferenceEntry[] {
  const refs: ReferenceEntry[] = [];
  for (const match of recognizer.scanReferencePatterns(source)) {
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
  source: string | ExactSource,
  lineOffset: number,
  uri: string,
): ReferenceEntry[] {
  return scanIncludes(source).map((include) => ({
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

function pushDefines(
  source: string | ExactSource,
  lineOffset: number,
  uri: string,
  dest: SymbolEntry[],
): void {
  const defines = scanDefines(source);
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
  recognizer?: MacroPatternRecognizer,
  preparedAnalysis?: DocumentAnalysis,
  liveSession?: LiveDocumentTreeSession,
  preparedSource?: ExactSource,
): Promise<FileIndex> {
  if (liveSession) {
    return liveSession.indexFile(uri, text, recognizer, preparedAnalysis, preparedSource);
  }
  return indexFileWithTemporaryTrees(
    uri,
    text,
    recognizer,
    preparedAnalysis,
    createHlslParser,
    preparedSource,
  );
}

export async function indexFileWithTemporaryTrees(
  uri: string,
  text: string,
  recognizer?: MacroPatternRecognizer,
  preparedAnalysis?: DocumentAnalysis,
  createParser: HlslParserFactory = createHlslParser,
  preparedSource?: ExactSource,
): Promise<FileIndex> {
  let parser: Awaited<ReturnType<HlslParserFactory>> | undefined;
  const temporaryTrees: Parser.Tree[] = [];
  try {
    return await indexFileWithTreeProvider(
      uri,
      text,
      recognizer,
      preparedAnalysis,
      async (blockText) => {
        parser ??= await createParser();
        const tree = parser.parseStabilized(stabilizeHlslSource(blockText));
        temporaryTrees.push(tree);
        return tree;
      },
      preparedSource,
    );
  } finally {
    for (const tree of temporaryTrees) tree.delete();
    parser?.delete();
  }
}

export async function indexFileWithTreeProvider(
  uri: string,
  text: string,
  recognizer: MacroPatternRecognizer | undefined,
  preparedAnalysis: DocumentAnalysis | undefined,
  treeForBlock: (blockText: string, blockIndex: number) => Promise<Parser.Tree>,
  preparedSource?: ExactSource,
): Promise<FileIndex> {
  const analysis = preparedAnalysis && analysisMatchesSource(preparedAnalysis, text)
    ? preparedAnalysis
    : analyzeDocument(uri, text, 'index');
  const source = exactSource(
    text,
    preparedSource?.sourceText === text ? preparedSource : analysis,
  );
  const ext = extOf(uri);
  if (HLSL_EXTS.has(ext)) {
    const tree = await treeForBlock(text, 0);
    const idx = collect(tree.rootNode, text, uri, 0, recognizer);
    idx.references.push(...scanIncludeReferences(source, 0, uri));
    pushDefines(source, 0, uri, idx.symbols);
    if (recognizer) idx.references.push(...scanPragmas(source, 0, recognizer, uri));
    idx.shaderContext = scanShaderContextSource(source);
    return idx;
  }

  if (ext === '.shader') {
    if (!analysis) throw new Error(`missing ShaderLab analysis for ${uri}`);
    const { blocks, structure } = analysis;
    const lines = source.sourceLines;

    const merged: FileIndex = { uri, symbols: [], references: [] };
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      const blockLines = lines.slice(block.contentStartLine, block.contentEndLine + 1);
      const blockText = blockLines.join('\n');
      const blockSource: ExactSource = { sourceText: blockText, sourceLines: blockLines };
      const tree = await treeForBlock(blockText, blockIndex);
      const part = collect(
        tree.rootNode,
        blockText,
        uri,
        block.contentStartLine,
        recognizer,
      );
      merged.symbols.push(...part.symbols);
      pushDefines(blockSource, block.contentStartLine, uri, merged.symbols);
      merged.references.push(...part.references);
      merged.references.push(...scanIncludeReferences(blockSource, block.contentStartLine, uri));
      if (recognizer) {
        merged.references.push(...scanPragmas(
          blockSource,
          block.contentStartLine,
          recognizer,
          uri,
        ));
      }
    }
    merged.structure = structure;
    merged.shaderLabNames = analysis.shaderLabNames;
    merged.shaderLabMaterial = analysis.shaderLabMaterial;
    merged.shaderContext = scanShaderContextSource(source, blocks, structure);
    const properties = analysis.shaderLabProperties.entries;
    if (properties.length > 0) merged.properties = [...properties];
    return merged;
  }

  return { uri, symbols: [], references: [] };
}
