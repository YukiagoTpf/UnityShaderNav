import { describe, expect, it } from 'vitest';
import type { Range } from '@unity-shader-nav/shared';
import type { ReferenceTarget } from '../../src/index/referenceResolver';
import {
  isReferenceContextCompatible,
  sameMethodOverload,
  sameTarget,
  uniqueLocations,
} from '../../src/index/referenceMatching';

const range: Range = {
  start: { line: 2, character: 4 },
  end: { line: 2, character: 9 },
};

function target(uri: string): ReferenceTarget {
  return { name: 'Color', kind: 'variable', uri, range };
}

describe('reference identity matching', () => {
  it('matches reference contexts to the symbol kinds that can own them', () => {
    const functionTarget = { ...target('file:///project/Functions.hlsl'), kind: 'function' } as const;
    const structTarget = { ...target('file:///project/Types.hlsl'), kind: 'struct' } as const;
    const variableTarget = target('file:///project/Variables.hlsl');

    expect(isReferenceContextCompatible(functionTarget, 'call')).toBe(true);
    expect(isReferenceContextCompatible(functionTarget, 'pragma')).toBe(true);
    expect(isReferenceContextCompatible(functionTarget, 'identifier')).toBe(false);
    expect(isReferenceContextCompatible(structTarget, 'type')).toBe(true);
    expect(isReferenceContextCompatible(structTarget, 'call')).toBe(false);
    expect(isReferenceContextCompatible(variableTarget, 'member')).toBe(true);
  });

  it('keeps method locations distinct while recognizing their shared overload', () => {
    const declaration: ReferenceTarget = {
      name: 'Shade',
      kind: 'function',
      parentType: 'Surface',
      methodSignature: 'float|float',
      uri: 'file:///project/Surface.hlsl',
      range,
    };
    const definition: ReferenceTarget = {
      ...declaration,
      range: {
        start: { line: 8, character: 10 },
        end: { line: 8, character: 15 },
      },
    };

    expect(sameTarget(declaration, definition)).toBe(false);
    expect(sameMethodOverload(declaration, definition)).toBe(true);
    expect(sameMethodOverload(declaration, {
      ...definition,
      methodSignature: 'float|float,float',
    })).toBe(false);
  });

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
