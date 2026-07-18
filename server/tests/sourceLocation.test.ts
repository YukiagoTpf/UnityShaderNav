import type { Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import {
  containsPosition,
  isBeforeOrAt,
  locationKey,
  rangeKey,
  symbolToLocationLink,
  uriBasename,
} from '../src/sourceLocation';

const range: Range = {
  start: { line: 2, character: 3 },
  end: { line: 4, character: 5 },
};

describe('source location', () => {
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
  });

  it.each([
    [{ line: 1, character: 9 }, { line: 2, character: 0 }, true],
    [{ line: 2, character: 3 }, { line: 2, character: 3 }, true],
    [{ line: 2, character: 2 }, { line: 2, character: 3 }, true],
    [{ line: 2, character: 4 }, { line: 2, character: 3 }, false],
    [{ line: 3, character: 0 }, { line: 2, character: 99 }, false],
  ] satisfies Array<[Position, Position, boolean]>)('orders %j before or at %j', (left, right, expected) => {
    expect(isBeforeOrAt(left, right)).toBe(expected);
  });

  it('formats range and caller-owned URI identity deterministically', () => {
    expect(rangeKey(range)).toBe('2:3:4:5');
    expect(locationKey('file:///Project/Main.hlsl', range))
      .toBe('file:///Project/Main.hlsl:2:3:4:5');
  });

  it('extracts a decoded URI basename without query or fragment metadata', () => {
    expect(uriBasename('file:///Project/My%20Shader.hlsl?version=1#L2'))
      .toBe('My Shader.hlsl');
    expect(uriBasename('untitled:Shader')).toBeUndefined();
    expect(uriBasename('file:///Project/')).toBeUndefined();
    expect(uriBasename('file:///Project/%ZZ.hlsl')).toBe('%ZZ.hlsl');
  });

  it('formats symbols as links with an optional origin selection', () => {
    const symbol: SymbolEntry = {
      name: 'Main',
      kind: 'function',
      location: { uri: 'file:///Main.hlsl', range },
    };
    const origin: Range = {
      start: { line: 9, character: 1 },
      end: { line: 9, character: 5 },
    };

    expect(symbolToLocationLink(symbol)).toEqual({
      targetUri: symbol.location.uri,
      targetRange: range,
      targetSelectionRange: range,
    });
    expect(symbolToLocationLink(symbol, origin)).toMatchObject({
      originSelectionRange: origin,
    });
  });
});
