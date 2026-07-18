import type { Position } from '@unity-shader-nav/shared';
import { classifyCursor, type CursorContext, type CursorSource } from './cursor';

// Generic definition lookup is allowed only in HLSL code, including semantic positions.
export function isGenericDefinitionContext(
  text: string | CursorSource,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): boolean {
  const classification = classifyCursor(text, pos, languageId, uri).classification;
  return classification === 'hlslCode' || classification === 'semanticPosition';
}

export function isGenericDefinitionCursor(cursor: CursorContext): boolean {
  return cursor.classification === 'hlslCode'
    || cursor.classification === 'semanticPosition';
}
