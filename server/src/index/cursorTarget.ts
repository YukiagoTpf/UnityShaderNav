import type { Position } from '@unity-shader-nav/shared';
import { scanIncludes, type IncludeDirective } from '../parser/include/lineScanner';
import {
  memberAccessAt,
  type CursorContext,
  type CursorSource,
  type WordAt,
} from '../parser/lexical/cursor';
import { containsPosition, exactSource } from '../sourceLocation';

export type CursorTarget =
  | { kind: 'include'; include: IncludeDirective }
  | { kind: 'member';  receiver: WordAt; member: WordAt }
  | { kind: 'symbol';  word: WordAt }
  | { kind: 'none' };

export interface CursorTargetOptions {
  detectIncludes?: boolean;
  cursor?: CursorContext;
}

export function cursorTargetAt(
  text: string | CursorSource,
  position: Position,
  options: CursorTargetOptions = {},
): CursorTarget {
  const { detectIncludes = true } = options;
  const source = exactSource(
    typeof text === 'string' ? text : text.sourceText,
    typeof text === 'string' ? undefined : text,
  ) as CursorSource;
  if (detectIncludes) {
    const include = scanIncludes(source).find((directive) => (
      containsPosition(directive.pathRange, position)
    ));
    if (include) return { kind: 'include', include };
  }
  const ma = options.cursor?.member ?? memberAccessAt(source, position);
  if (!ma) return { kind: 'none' };
  if (ma.receiver) return { kind: 'member', receiver: ma.receiver, member: ma.member };
  return { kind: 'symbol', word: ma.member };
}
