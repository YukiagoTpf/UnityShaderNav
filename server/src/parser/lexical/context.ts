import type { Position } from '@unity-shader-nav/shared';
import { classifyCursor } from './cursor';

// Generic definition lookup is allowed only in HLSL code, including semantic positions.
export function isGenericDefinitionContext(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): boolean {
  const classification = classifyCursor(text, pos, languageId, uri).classification;
  return classification === 'hlslCode' || classification === 'semanticPosition';
}
