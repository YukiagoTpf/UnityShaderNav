import { describe, expect, it } from 'vitest';
import type { Position, Range } from '@unity-shader-nav/shared';
import {
  containsPosition,
  inRange,
  isBeforeOrAt,
} from '../../src/index/positionGeometry';

const range: Range = {
  start: { line: 2, character: 3 },
  end: { line: 4, character: 5 },
};

describe('position geometry', () => {
  it.each([
    [{ line: 2, character: 3 }, true],
    [{ line: 2, character: 8 }, true],
    [{ line: 3, character: 0 }, true],
    [{ line: 4, character: 5 }, true],
    [{ line: 2, character: 2 }, false],
    [{ line: 4, character: 6 }, false],
    [{ line: 1, character: 99 }, false],
    [{ line: 5, character: 0 }, false],
  ] satisfies Array<[Position, boolean]>)('uses inclusive range endpoints for %j', (position, expected) => {
    expect(containsPosition(range, position)).toBe(expected);
    expect(inRange(position, range)).toBe(expected);
  });

  it.each([
    [{ line: 1, character: 9 }, { line: 2, character: 0 }, true],
    [{ line: 2, character: 3 }, { line: 2, character: 3 }, true],
    [{ line: 2, character: 2 }, { line: 2, character: 3 }, true],
    [{ line: 2, character: 4 }, { line: 2, character: 3 }, false],
    [{ line: 3, character: 0 }, { line: 2, character: 99 }, false],
  ] satisfies Array<[Position, Position, boolean]>)('orders %j before or at %j', (a, b, expected) => {
    expect(isBeforeOrAt(a, b)).toBe(expected);
  });
});
