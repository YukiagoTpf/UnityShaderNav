import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ShaderLabBlock,
  ShaderLabMaterialFacts,
  ShaderLabNameFacts,
  StructureResult,
} from '@unity-shader-nav/shared';
import {
  scanShaderLabLayout,
  type ShaderLabLayoutAnalysis,
} from '../parser/shaderlab/layoutScanner';
import { scanShaderLabNames } from '../parser/shaderlab/nameScanner';
import { scanShaderLabMaterialFacts } from '../parser/shaderlab/materialCbufferScanner';
import {
  scanShaderLabPropertyFacts,
  type ShaderLabPropertyFacts,
} from '../parser/shaderlab/propertiesScanner';
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
  readonly layout: ShaderLabLayoutAnalysis;
  readonly structure: StructureResult;
  readonly shaderLabNames: ShaderLabNameFacts;
  readonly shaderLabMaterial: ShaderLabMaterialFacts;
  readonly shaderLabProperties: ShaderLabPropertyFacts;
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

  const layout = scanShaderLabLayout(text);
  const blocks = layout.blocks;
  const structure = layout.structure;
  const shaderLabNames = scanShaderLabNames(text, blocks, structure);
  const shaderLabMaterial = scanShaderLabMaterialFacts(text, blocks, structure);
  const shaderLabProperties = scanShaderLabPropertyFacts(text, blocks);
  const lexicalTokens = demand === 'full'
    ? scanShaderLabTokens(text, blocks)
    : undefined;
  return deepFreeze({
    sourceText: text,
    blocks,
    layout,
    structure,
    shaderLabNames,
    shaderLabMaterial,
    shaderLabProperties,
    lexicalTokens,
  });
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
