import { describe, it, expect } from 'vitest';
import type { FileIndex, SymbolEntry } from '@unity-shader-nav/shared';
import { resolveDefinition } from '../../src/index/symbolResolver';

function sym(over: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return {
    location: {
      uri: 'file:///t/x.hlsl',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
    ...over,
  } as SymbolEntry;
}

describe('resolveDefinition: same-file function', () => {
  it('returns the function symbol when name matches', () => {
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [
        sym({
          name: 'add',
          kind: 'function',
          location: {
            uri: 'file:///t/x.hlsl',
            range: { start: { line: 5, character: 7 }, end: { line: 5, character: 10 } },
          },
        }),
      ],
      references: [],
    };

    const result = resolveDefinition(idx, 'add', { line: 10, character: 4 });

    expect(result).toHaveLength(1);
    expect(result[0].targetUri).toBe('file:///t/x.hlsl');
    expect(result[0].targetRange.start.line).toBe(5);
  });
});

describe('resolveDefinition: proximity tie-break for locals', () => {
  it('picks the local declaration with the largest line <= reference line', () => {
    const scopeRange = { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } };
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [
        sym({
          name: 'i',
          kind: 'localVariable',
          scope: 'f',
          scopeRange,
          location: {
            uri: 'file:///t/x.hlsl',
            range: { start: { line: 3, character: 8 }, end: { line: 3, character: 9 } },
          },
        }),
        sym({
          name: 'i',
          kind: 'localVariable',
          scope: 'f',
          scopeRange,
          location: {
            uri: 'file:///t/x.hlsl',
            range: { start: { line: 7, character: 8 }, end: { line: 7, character: 9 } },
          },
        }),
      ],
      references: [],
    };

    const result = resolveDefinition(idx, 'i', { line: 10, character: 0 });

    expect(result).toHaveLength(1);
    expect(result[0].targetRange.start.line).toBe(7);
  });
});

describe('resolveDefinition: multi-candidate for global names', () => {
  it('returns all matching global functions when multiple share a name', () => {
    const idx: FileIndex = {
      uri: 'file:///t/x.shader',
      symbols: [
        sym({
          name: 'vert',
          kind: 'function',
          location: {
            uri: 'file:///t/x.shader',
            range: { start: { line: 10, character: 0 }, end: { line: 10, character: 4 } },
          },
        }),
        sym({
          name: 'vert',
          kind: 'function',
          location: {
            uri: 'file:///t/x.shader',
            range: { start: { line: 30, character: 0 }, end: { line: 30, character: 4 } },
          },
        }),
      ],
      references: [],
    };

    const result = resolveDefinition(idx, 'vert', { line: 12, character: 1 });

    expect(result).toHaveLength(2);
  });
});

describe('resolveDefinition: parameter then global', () => {
  it('parameter inside its scope shadows same-name global', () => {
    const scopeRange = { start: { line: 5, character: 0 }, end: { line: 15, character: 0 } };
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [
        sym({
          name: 'x',
          kind: 'variable',
          location: {
            uri: 'file:///t/x.hlsl',
            range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } },
          },
        }),
        sym({
          name: 'x',
          kind: 'parameter',
          scope: 'f',
          scopeRange,
          location: {
            uri: 'file:///t/x.hlsl',
            range: { start: { line: 5, character: 20 }, end: { line: 5, character: 21 } },
          },
        }),
      ],
      references: [],
    };

    const result = resolveDefinition(idx, 'x', { line: 10, character: 4 });

    expect(result).toHaveLength(1);
    expect(result[0].targetRange.start.line).toBe(5);
  });
});
