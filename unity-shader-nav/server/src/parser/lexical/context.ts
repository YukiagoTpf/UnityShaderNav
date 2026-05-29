import type { Position } from '@unity-shader-nav/shared';
import { lexicalContextAt, isShaderLabDocument, isInsideShaderLabHlslBlock } from './cursor';

export function isGenericDefinitionContext(
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): boolean {
  if (isShaderLabDocument(languageId, uri) && !isInsideShaderLabHlslBlock(text, pos)) {
    return false;
  }

  return lexicalContextAt(text, pos) === 'code';
}
