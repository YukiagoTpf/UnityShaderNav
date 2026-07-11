import type { Position, Range } from '@unity-shader-nav/shared';

/** True when position lies within range, including both endpoints. */
export function containsPosition(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

export function inRange(position: Position, range: Range): boolean {
  return containsPosition(range, position);
}

export function isBeforeOrAt(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}
