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
      {
        name: 'MakeSurface',
        kind: 'function',
        returnType: 'Surface',
        parameters: [],
        location: {
          uri: 'file:///t/Surface.hlsl',
          range: { start: { line: 3, character: 8 }, end: { line: 3, character: 19 } },
        },
      },
    ],
  });
  return global;
}

function globalWithIssue9Types(): GlobalSymbolIndex {
  const global = new GlobalSymbolIndex();
  global.upsert({
    uri: 'file:///t/Types.hlsl',
    references: [],
    symbols: [
      sym({ name: 'Light', kind: 'struct', location: { uri: 'file:///t/Types.hlsl', range: memberRange } }),
      sym({
        name: 'color',
        kind: 'structMember',
        parentType: 'Light',
        declaredType: 'float3',
        location: {
          uri: 'file:///t/Types.hlsl',
          range: { start: { line: 1, character: 9 }, end: { line: 1, character: 14 } },
        },
      }),
      sym({ name: 'Brdf', kind: 'struct', location: { uri: 'file:///t/Types.hlsl', range: memberRange } }),
      sym({
        name: 'roughness',
        kind: 'structMember',
        parentType: 'Brdf',
        declaredType: 'float',
        location: {
          uri: 'file:///t/Types.hlsl',
          range: { start: { line: 5, character: 8 }, end: { line: 5, character: 17 } },
        },
      }),
      sym({ name: 'Surface', kind: 'struct', location: { uri: 'file:///t/Types.hlsl', range: memberRange } }),
      sym({
        name: 'brdfData',
        kind: 'structMember',
        parentType: 'Surface',
        declaredType: 'Brdf',
        location: {
          uri: 'file:///t/Types.hlsl',
          range: { start: { line: 9, character: 7 }, end: { line: 9, character: 15 } },
        },
      }),
      sym({ name: 'Settings', kind: 'struct', location: { uri: 'file:///t/Types.hlsl', range: memberRange } }),
      sym({
        name: 'value',
        kind: 'structMember',
        parentType: 'Settings',
        declaredType: 'float',
        location: {
          uri: 'file:///t/Types.hlsl',
          range: { start: { line: 13, character: 8 }, end: { line: 13, character: 13 } },
        },
      }),
      {
        name: 'MakeSurface',
        kind: 'function',
        returnType: 'Surface',
        parameters: [],
        location: {
          uri: 'file:///t/Surface.hlsl',
          range: { start: { line: 3, character: 8 }, end: { line: 3, character: 19 } },
        },
      },
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

  it('resolves a member through an array element receiver', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'lights',
          kind: 'parameter',
          declaredType: 'Light',
          scopeRange: functionScope,
          location: { uri, range: { start: { line: 5, character: 15 }, end: { line: 5, character: 21 } } },
        }),
      ],
    };

    const links = resolveMember(idx, globalWithIssue9Types(), 'lights[i]', 'color', { line: 8, character: 24 });

    expect(links).toHaveLength(1);
    expect(links[0].targetRange).toEqual({
      start: { line: 1, character: 9 },
      end: { line: 1, character: 14 },
    });
  });

  it('resolves a member through a nested field receiver', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'surface',
          kind: 'localVariable',
          declaredType: 'Surface',
          scopeRange: functionScope,
          location: { uri, range: { start: { line: 6, character: 10 }, end: { line: 6, character: 17 } } },
        }),
      ],
    };

    const links = resolveMember(
      idx,
      globalWithIssue9Types(),
      'surface.brdfData',
      'roughness',
      { line: 9, character: 31 },
    );

    expect(links).toHaveLength(1);
    expect(links[0].targetRange).toEqual({
      start: { line: 5, character: 8 },
      end: { line: 5, character: 17 },
    });
  });

  it('resolves a member through a cbuffer struct global receiver', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 'settings',
          kind: 'variable',
          declaredType: 'Settings',
          location: { uri, range: { start: { line: 3, character: 11 }, end: { line: 3, character: 19 } } },
        }),
      ],
    };

    const links = resolveMember(idx, globalWithIssue9Types(), 'settings', 'value', { line: 7, character: 21 });

    expect(links).toHaveLength(1);
    expect(links[0].targetRange).toEqual({
      start: { line: 13, character: 8 },
      end: { line: 13, character: 13 },
    });
  });

  it('infers an unknown receiver type from the nearest preceding call assignment', () => {
    const global = globalWithSurface();
    global.upsert({
      uri,
      references: [],
      symbols: [{
        name: 'MakeOther',
        kind: 'function',
        returnType: 'Other',
        parameters: [],
        location: {
          uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
        },
      }],
    });
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [],
      typeInferences: [
        {
          receiver: 'surface',
          callName: 'MakeOther',
          assignmentRange: { start: { line: 6, character: 2 }, end: { line: 6, character: 23 } },
          scope: 'frag',
          scopeRange: functionScope,
        },
        {
          receiver: 'surface',
          callName: 'MakeSurface',
          assignmentRange: { start: { line: 8, character: 2 }, end: { line: 8, character: 25 } },
          scope: 'frag',
          scopeRange: functionScope,
        },
      ],
    };

    const links = resolveMember(idx, global, 'surface', 'positionWS', { line: 10, character: 22 });

    expect(links).toHaveLength(1);
    expect(links[0].targetRange).toEqual(memberRange);
  });

  it('does not resolve unsupported call-like receiver expressions through their root identifier', () => {
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

    const links = resolveMember(idx, globalWithSurface(), 'surface.Make()', 'positionWS', {
      line: 10,
      character: 31,
    });

    expect(links).toEqual([]);
  });

  it('does not infer receiver type from a call assignment without a visible function candidate', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [],
      typeInferences: [{
        receiver: 'surface',
        callName: 'MakeMissing',
        assignmentRange: { start: { line: 8, character: 2 }, end: { line: 8, character: 25 } },
        scope: 'frag',
        scopeRange: functionScope,
      }],
    };

    const links = resolveMember(idx, globalWithSurface(), 'surface', 'positionWS', { line: 10, character: 22 });

    expect(links).toEqual([]);
  });

  it('does not infer receiver type from an ambiguous call assignment target', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [{
        name: 'MakeSurface',
        kind: 'function',
        returnType: 'Surface',
        parameters: [],
        location: {
          uri,
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 11 } },
        },
      } as SymbolEntry],
      typeInferences: [{
        receiver: 'surface',
        callName: 'MakeSurface',
        assignmentRange: { start: { line: 8, character: 2 }, end: { line: 8, character: 25 } },
        scope: 'frag',
        scopeRange: functionScope,
      }],
    };

    const links = resolveMember(idx, globalWithSurface(), 'surface', 'positionWS', { line: 10, character: 22 });

    expect(links).toEqual([]);
  });
});
