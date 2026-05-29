import type { Position } from '@unity-shader-nav/shared';
import { scanIncludes, type IncludeDirective } from '../parser/include/lineScanner';
import { memberAccessAt, type WordAt } from './wordAt';

export type CursorTarget =
  | { kind: 'include'; include: IncludeDirective }
  | { kind: 'member';  receiver: WordAt; member: WordAt }
  | { kind: 'symbol';  word: WordAt }
  | { kind: 'none' };

export interface CursorTargetOptions { detectIncludes?: boolean }

export function cursorTargetAt(
  text: string,
  position: Position,
  options: CursorTargetOptions = {},
): CursorTarget {
  const { detectIncludes = true } = options;
  if (detectIncludes) {
    const include = scanIncludes(text).find((d) =>
      d.line === position.line
      && position.character >= d.pathRange.start.character
      && position.character <= d.pathRange.end.character);
    if (include) return { kind: 'include', include };
  }
  const ma = memberAccessAt(text, position);
  if (!ma) return { kind: 'none' };
  if (ma.receiver) return { kind: 'member', receiver: ma.receiver, member: ma.member };
  return { kind: 'symbol', word: ma.member };
}
