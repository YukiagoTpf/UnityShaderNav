import type { Position, Range } from '@unity-shader-nav/shared';
import type { DocumentLexicalToken } from '../analysis';
import {
  analyzeCursor,
  type CursorContext,
  type CursorSource,
} from '../parser/lexical/cursor';
import {
  containsPosition,
  exactSource,
  textInRange,
} from '../sourceLocation';

export type DocumentationTargetRole =
  | 'shaderLabTerm'
  | 'renderStateValue'
  | 'propertyAttribute'
  | 'propertyType'
  | 'semantic'
  | 'hlslIdentifier';

export interface DocumentationTarget {
  readonly role: DocumentationTargetRole;
  readonly name: string;
  readonly range: Range;
}

export function documentationTargetAt(
  text: string | CursorSource,
  position: Position,
  languageId: string,
  uri: string,
  lexicalTokens: readonly DocumentLexicalToken[] | undefined,
  cursorFacts?: CursorContext,
): DocumentationTarget | undefined {
  const source = exactSource(
    typeof text === 'string' ? text : text.sourceText,
    typeof text === 'string' ? undefined : text,
  ) as CursorSource;
  const cursor = cursorFacts ?? analyzeCursor(source, position, languageId, uri);
  if (cursor.lexical !== 'code') return undefined;
  const token = lexicalTokens?.find((candidate) => containsPosition(candidate.range, position));
  if (token) {
    const name = textInRange(source, token.range);
    if (!name) return undefined;
    if (token.tokenType === 'decorator') {
      return { role: 'propertyAttribute', name, range: token.range };
    }
    if (token.tokenType === 'type' && cursor.classification === 'shaderLabCode') {
      return { role: 'propertyType', name, range: token.range };
    }
    if (token.tokenType === 'keyword' && cursor.classification === 'shaderLabCode') {
      return { role: 'shaderLabTerm', name, range: token.range };
    }
    if (token.tokenType === 'enumMember' && cursor.classification === 'semanticPosition') {
      return { role: 'semantic', name, range: token.range };
    }
  }
  if (!cursor.word) return undefined;
  if (cursor.classification === 'shaderLabStateValue') {
    return { role: 'renderStateValue', name: cursor.word.text, range: cursor.word.range };
  }
  if (cursor.classification === 'semanticPosition') {
    return { role: 'semantic', name: cursor.word.text, range: cursor.word.range };
  }
  if (cursor.classification === 'hlslCode') {
    return { role: 'hlslIdentifier', name: cursor.word.text, range: cursor.word.range };
  }
  return undefined;
}
