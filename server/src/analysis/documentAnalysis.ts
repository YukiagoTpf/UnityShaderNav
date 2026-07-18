import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ShaderLabBlock,
  ShaderLabMaterialFacts,
  ShaderLabNameFacts,
  StructureResult,
} from '@unity-shader-nav/shared';
import {
  scanShaderLabLayoutFromSource,
  type ShaderLabLayoutAnalysis,
} from '../parser/shaderlab/layoutScanner';
import { scanShaderLabNamesFromSource } from '../parser/shaderlab/nameScanner';
import { scanShaderLabMaterialFactsFromSource } from '../parser/shaderlab/materialCbufferScanner';
import {
  scanShaderLabPropertyFactsFromSource,
  type ShaderLabPropertyFacts,
} from '../parser/shaderlab/propertiesScanner';
import { interpretShaderLabSource } from '../parser/shaderlab/sourceInterpretation';
import {
  scanShaderLabTokensFromSource,
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
  readonly sourceLines: readonly string[];
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

  const source = interpretShaderLabSource(text);
  const layout = scanShaderLabLayoutFromSource(source);
  const blocks = layout.blocks;
  const structure = layout.structure;
  const shaderLabNames = scanShaderLabNamesFromSource(source, blocks, structure);
  const shaderLabMaterial = scanShaderLabMaterialFactsFromSource(source, blocks, structure);
  const shaderLabProperties = scanShaderLabPropertyFactsFromSource(source, blocks);
  const lexicalTokens = demand === 'full'
    ? scanShaderLabTokensFromSource(source, blocks)
    : undefined;
  // Nested projections are readonly contracts owned by their scanners. Freeze
  // only the aggregate shell so analysis does not walk the same large graph a
  // second time on every live edit.
  return Object.freeze({
    sourceText: text,
    sourceLines: source.lines.map((line) => line.raw),
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
