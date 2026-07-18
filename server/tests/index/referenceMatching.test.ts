import { describe, expect, it } from 'vitest';
import type { Range } from '@unity-shader-nav/shared';
import type { ReferenceTarget } from '../../src/index/referenceResolver';
import { sameTarget, uniqueLocations } from '../../src/index/referenceMatching';

const range: Range = {
  start: { line: 2, character: 4 },
  end: { line: 2, character: 9 },
};

function target(uri: string): ReferenceTarget {
  return { name: 'Color', kind: 'variable', uri, range };
}

describe('reference identity matching', () => {
  it('matches targets through canonical file identity', () => {
    expect(sameTarget(
      target('file:///C:/Unity/Project/Color.hlsl'),
      target('file:///c:/unity/project/color.hlsl'),
    )).toBe(true);
  });

  it('deduplicates locations through canonical file identity', () => {
    expect(uniqueLocations([
      { uri: 'file:///C:/Unity/Project/Color.hlsl', range },
      { uri: 'file:///c:/unity/project/color.hlsl', range },
    ])).toEqual([{ uri: 'file:///C:/Unity/Project/Color.hlsl', range }]);
  });
});
