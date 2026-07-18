import type { Position } from '@unity-shader-nav/shared';
import { classifyCursor } from '../parser/lexical/cursor';
import type {
  CompletionPrefix,
  CursorContext,
  CursorSource,
  SuggestionContextKind,
} from '../parser/lexical/cursor';

// Re-export so the suggestions barrel surface is unchanged after the seam move.
export type { SuggestionContextKind, CompletionPrefix };

export interface SuggestionContext {
  kind: SuggestionContextKind;
  prefix: CompletionPrefix;
  member?: {
    receiver: string;
    memberPrefix: CompletionPrefix;
  };
}

export function suggestionContextAt(
  text: string | CursorSource,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): SuggestionContext {
  const c = classifyCursor(text, pos, languageId, uri);
  if (c.lexical !== 'code') return { kind: c.classification, prefix: c.prefix };
  return { kind: c.classification, prefix: c.prefix, member: c.member };
}

export function suggestionContextFromCursor(cursor: CursorContext): SuggestionContext {
  if (cursor.lexical !== 'code') {
    return { kind: cursor.classification, prefix: cursor.prefix };
  }
  return {
    kind: cursor.classification,
    prefix: cursor.prefix,
    member: cursor.memberPrefix,
  };
}
