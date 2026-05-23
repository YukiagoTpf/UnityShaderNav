import { describe, expect, it } from 'vitest';
import type { FileIndex, Range, SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex } from '../../src/index/globalIndex';
import { resolveMember } from '../../src/index/chainLookup';

const uri = 'file:///t/main.hlsl';
const memberRange: Range = { start: { line: 1, character: 11 }, end: { line: 1, character: 21 } };
const functionScope: Range = { start: { line: 5, character: 0 }, end: { line: 30, character: 0 } };

function sym(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return {
    location: {
      uri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    },
    ...overrides,
  } as SymbolEntry;
}

function globalWithSurface(): GlobalSymbolIndex {
  const global = new GlobalSymbolIndex();
  global.upsert({
    uri: 'file:///t/Surface.hlsl',
    references: [],
    symbols: [
      sym({
        name: 'Surface',
        kind: 'struct',
        location: {
          uri: 'file:///t/Surface.hlsl',
          range: { start: { line: 0, character: 7 }, end: { line: 0, character: 14 } },
        },
      }),
      sym({
        name: 'positionWS',
        kind: 'structMember',
        parentType: 'Surface',
        location: { uri: 'file:///t/Surface.hlsl', range: memberRange },
      }),
    ],
  });
  return global;
}

describe('resolveMember', () => {
  it('resolves a member through a function parameter receiver', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'surface',
          kind: 'parameter',
          declaredType: 'Surface',
          scopeRange: functionScope,
          location: { uri, range: { start: { line: 5, character: 18 }, end: { line: 5, character: 25 } } },
        }),
      ],
    };

    const links = resolveMember(idx, globalWithSurface(), 'surface', 'positionWS', { line: 10, character: 19 });

    expect(links).toHaveLength(1);
    expect(links[0].targetUri).toBe('file:///t/Surface.hlsl');
    expect(links[0].targetRange).toEqual(memberRange);
  });

  it('resolves a member through the nearest local receiver in scope', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'surface',
          kind: 'localVariable',
          declaredType: 'Other',
          scopeRange: functionScope,
          location: { uri, range: { start: { line: 6, character: 10 }, end: { line: 6, character: 17 } } },
        }),
        sym({
          name: 'surface',
          kind: 'localVariable',
          declaredType: 'Surface',
          scopeRange: functionScope,
          location: { uri, range: { start: { line: 8, character: 10 }, end: { line: 8, character: 17 } } },
        }),
      ],
    };

    const links = resolveMember(idx, globalWithSurface(), 'surface', 'positionWS', { line: 12, character: 19 });

    expect(links).toHaveLength(1);
    expect(links[0].targetUri).toBe('file:///t/Surface.hlsl');
  });

  it('resolves a member through a file-level global receiver', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'gSurface',
          kind: 'variable',
          declaredType: 'Surface',
          location: { uri, range: { start: { line: 0, character: 8 }, end: { line: 0, character: 16 } } },
        }),
      ],
    };

    const links = resolveMember(idx, globalWithSurface(), 'gSurface', 'positionWS', { line: 4, character: 12 });

    expect(links).toHaveLength(1);
    expect(links[0].targetUri).toBe('file:///t/Surface.hlsl');
  });

  it('does not duplicate a current-file struct member that also exists in the global index', () => {
    const surfaceStruct = sym({ name: 'Surface', kind: 'struct' });
    const surfaceMember = sym({
      name: 'positionWS',
      kind: 'structMember',
      parentType: 'Surface',
      location: { uri, range: memberRange },
    });
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'surface',
          kind: 'parameter',
          declaredType: 'Surface',
          scopeRange: functionScope,
        }),
        surfaceStruct,
        surfaceMember,
      ],
    };
    const global = new GlobalSymbolIndex();
    global.upsert(idx);

    const links = resolveMember(idx, global, 'surface', 'positionWS', { line: 10, character: 19 });

    expect(links).toHaveLength(1);
    expect(links[0].targetUri).toBe(uri);
  });
});
