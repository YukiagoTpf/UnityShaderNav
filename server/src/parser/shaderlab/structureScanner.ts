import type { StructureResult } from '@unity-shader-nav/shared';
import { scanShaderLabLayout } from './layoutScanner';

/** Compatibility projection for consumers that only need Outline structure. */
export function scanStructure(text: string): StructureResult {
  return scanShaderLabLayout(text).structure;
}
