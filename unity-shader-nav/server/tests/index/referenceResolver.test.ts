import { describe, expect, it } from 'vitest';
import type { FileIndex, Range, SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, resolveReferenceTargets } from '../../src/index';

const uri = 'file:///project/Assets/Main.hlsl';

function range(line: number, start: number, end: number): Range {
  return {
    start: { line, character: start },
    end: { line, character: end },
  };
}

function scope(startLine: number, startCharacter: number, endLine: number, endCharacter: number): Range {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function sym(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return {
    location: {
      uri,
      range: range(0, 0, 0),
    },
    ...overrides,
  } as SymbolEntry;
}

describe('resolveReferenceTargets', () => {
  it('targets a local variable without merging another function local with the same name', () => {
    const firstScope = scope(0, 0, 3, 1);
    const secondScope = scope(4, 0, 7, 1);
    const text = [
      'float First() {',
      '  float value = 1;',
      '  return value;',
      '}',
      'float Second() {',
      '  float value = 2;',
      '  return value;',
      '}',
    ].join('\n');
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'value',
          kind: 'localVariable',
          scope: 'First',
          scopeRange: firstScope,
          location: { uri, range: range(1, 8, 13) },
        }),
        sym({
          name: 'value',
          kind: 'localVariable',
          scope: 'Second',
          scopeRange: secondScope,
          location: { uri, range: range(5, 8, 13) },
        }),
      ],
    };

    const targets = resolveReferenceTargets(idx, text, { line: 2, character: 10 });

    expect(targets).toEqual([
      {
        name: 'value',
        kind: 'localVariable',
        uri,
        range: range(1, 8, 13),
        scopeRange: firstScope,
      },
    ]);
  });

  it('targets a parameter with its scope range for same-scope filtering', () => {
    const scopeRange = scope(0, 0, 3, 1);
    const text = [
      'float2 Transform(float2 uv) {',
      '  float2 shifted = uv;',
      '  return shifted;',
      '}',
      'float2 uv;',
    ].join('\n');
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'uv',
          kind: 'parameter',
          scope: 'Transform',
          scopeRange,
          declaredType: 'float2',
          location: { uri, range: range(0, 24, 26) },
        }),
        sym({
          name: 'uv',
          kind: 'variable',
          declaredType: 'float2',
          location: { uri, range: range(4, 7, 9) },
        }),
      ],
    };

    const targets = resolveReferenceTargets(idx, text, { line: 1, character: 19 });

    expect(targets).toEqual([
      {
        name: 'uv',
        kind: 'parameter',
        uri,
        range: range(0, 24, 26),
        scopeRange,
      },
    ]);
  });

  it('targets a global function used by a call reference', () => {
    const text = 'float4 Main() { return Helper(); }';
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'Helper',
          kind: 'function',
          location: { uri, range: range(10, 7, 13) },
        }),
      ],
    };

    const targets = resolveReferenceTargets(idx, text, { line: 0, character: 23 });

    expect(targets).toEqual([
      {
        name: 'Helper',
        kind: 'function',
        uri,
        range: range(10, 7, 13),
      },
    ]);
  });

  it('targets a struct member only through the matching receiver parent type', () => {
    const text = 'float3 Read(Surface surface) { return surface.positionWS; }';
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'surface',
          kind: 'parameter',
          declaredType: 'Surface',
          scopeRange: scope(0, 0, 0, 55),
          location: { uri, range: range(0, 20, 27) },
        }),
      ],
    };
    const global = new GlobalSymbolIndex();
    global.upsert({
      uri: 'file:///project/Assets/Surface.hlsl',
      references: [],
      symbols: [
        {
          name: 'positionWS',
          kind: 'structMember',
          parentType: 'Surface',
          location: {
            uri: 'file:///project/Assets/Surface.hlsl',
            range: range(2, 9, 19),
          },
        },
        {
          name: 'positionWS',
          kind: 'structMember',
          parentType: 'OtherSurface',
          location: {
            uri: 'file:///project/Assets/OtherSurface.hlsl',
            range: range(7, 9, 19),
          },
        },
      ],
    });

    const targets = resolveReferenceTargets(idx, text, { line: 0, character: 47 }, global);

    expect(targets).toEqual([
      {
        name: 'positionWS',
        kind: 'structMember',
        parentType: 'Surface',
        uri: 'file:///project/Assets/Surface.hlsl',
        range: range(2, 9, 19),
      },
    ]);
  });
});
