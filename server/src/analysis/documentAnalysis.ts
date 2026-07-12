import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ShaderLabBlock,
  ShaderLabNameFacts,
  StructureResult,
} from '@unity-shader-nav/shared';
import { scanBlocks } from '../parser/shaderlab/blockScanner';
import { scanStructure } from '../parser/shaderlab/structureScanner';
import { scanShaderLabNames } from '../parser/shaderlab/nameScanner';
import {
  scanShaderLabTokens,
  type ShaderLabLexicalToken,
} from '../parser/shaderlab/tokenScanner';

export type DocumentLexicalToken = ShaderLabLexicalToken;

/**
 * Immutable facts derived from one exact ShaderLab source snapshot.
 *
 * The source string is retained only while an open-document overlay owns this
 * result. Disk records and persisted cache entries deliberately keep FileIndex
 * data only.
 */
export interface DocumentAnalysis {
  readonly sourceText: string;
  readonly blocks: readonly ShaderLabBlock[];
  readonly structure: StructureResult;
  readonly shaderLabNames: ShaderLabNameFacts;
  /** Present only for a live/full analysis cycle. */
  readonly lexicalTokens: readonly DocumentLexicalToken[] | undefined;
}

export type DocumentAnalysisDemand = 'index' | 'full';

/** Build one production analysis result. Non-ShaderLab files need no shared facts. */
export function analyzeDocument(
  uri: string,
  text: string,
  demand: DocumentAnalysisDemand = 'full',
): DocumentAnalysis | undefined {
  if (extensionOf(uri) !== '.shader') return undefined;

  const blocks = scanBlocks(text).blocks;
  const structure = scanStructure(text);
  const shaderLabNames = scanShaderLabNames(text, blocks, structure);
  const lexicalTokens = demand === 'full'
    ? scanShaderLabTokens(text, blocks)
    : undefined;
  return deepFreeze({ sourceText: text, blocks, structure, shaderLabNames, lexicalTokens });
}

/** Guard request-time reuse against a source snapshot that did not produce the facts. */
export function analysisMatchesSource(
  analysis: DocumentAnalysis,
  text: string,
): boolean {
  return analysis.sourceText === text;
}

function extensionOf(uri: string): string {
  try {
    return extname(fileURLToPath(uri)).toLowerCase();
  } catch {
    return extname(uri).toLowerCase();
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
