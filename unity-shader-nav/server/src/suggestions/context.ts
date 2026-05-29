import type { Position } from '@unity-shader-nav/shared';
import { classifyCursor } from '../parser/lexical/cursor';
import type { SuggestionContextKind, CompletionPrefix } from '../parser/lexical/cursor';

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
  text: string,
  pos: Position,
  languageId: string | undefined,
  uri: string,
): SuggestionContext {
  const c = classifyCursor(text, pos, languageId, uri);
  if (c.lexical !== 'code') return { kind: c.classification, prefix: c.prefix };
  return { kind: c.classification, prefix: c.prefix, member: c.member };
}
