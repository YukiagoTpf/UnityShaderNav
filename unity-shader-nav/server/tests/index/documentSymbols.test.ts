import { describe, expect, it } from 'vitest';
import { SymbolKind as LspSymbolKind } from 'vscode-languageserver/node';
import type { FileIndex, SymbolKind } from '@unity-shader-nav/shared';
import { buildDocumentSymbols } from '../../src/index/documentSymbols';

function sym(name: string, kind: SymbolKind, line: number, parentType?: string) {
  return {
    name,
    kind,
    parentType,
    location: {
      uri: 'file:///t/x.hlsl',
      range: {
        start: { line, character: 0 },
        end: { line, character: name.length },
      },
    },
  };
}

describe('buildDocumentSymbols: .hlsl', () => {
  it('returns top-level functions, structs, cbuffers, and pragma entries', () => {
    const idx: FileIndex = {
      uri: 'file:///t/x.hlsl',
      symbols: [
        sym('foo', 'function', 0),
        sym('Attributes', 'struct', 5),
        sym('positionOS', 'structMember', 6, 'Attributes'),
        sym('tmp', 'localVariable', 8),
        sym('UnityPerMaterial', 'cbuffer', 10),
      ],
      references: [{
        name: 'foo',
        context: 'pragma',
        location: {
          uri: 'file:///t/x.hlsl',
          range: {
            start: { line: 12, character: 15 },
            end: { line: 12, character: 18 },
          },
        },
      }],
    };

    const tree = buildDocumentSymbols(idx);

    expect(tree.map((node) => node.name)).toEqual([
      'foo',
      'Attributes',
      'UnityPerMaterial',
      '#pragma foo',
    ]);
    const attributes = tree.find((node) => node.name === 'Attributes');
    expect(attributes?.children?.map((node) => node.name)).toEqual(['positionOS']);
    const pragma = tree.find((node) => node.name === '#pragma foo');
    expect(pragma?.kind).toBe(LspSymbolKind.Event);
  });
});

describe('buildDocumentSymbols: .shader with structure', () => {
  it('nests HLSL symbols under the owning Pass', () => {
    const idx: FileIndex = {
      uri: 'file:///t/m.shader',
      symbols: [
        sym('vert', 'function', 5),
        sym('frag', 'function', 25),
      ],
      references: [],
      structure: {
        shaders: [{
          kind: 'shader',
          name: 'X',
          headerLine: 0,
          closeLine: 50,
          children: [{
            kind: 'subshader',
            headerLine: 1,
            closeLine: 49,
            children: [
              { kind: 'pass', name: 'Lit', headerLine: 2, closeLine: 20, children: [] },
              { kind: 'pass', name: 'Shadow', headerLine: 21, closeLine: 48, children: [] },
            ],
          }],
        }],
      },
    };

    const tree = buildDocumentSymbols(idx);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Shader "X"');
    const subshader = tree[0].children?.[0];
    expect(subshader?.name).toBe('SubShader');
    const passes = subshader?.children ?? [];
    expect(passes.map((node) => node.name)).toEqual(['Pass "Lit"', 'Pass "Shadow"']);
    expect(passes[0].children?.map((node) => node.name)).toEqual(['vert']);
    expect(passes[1].children?.map((node) => node.name)).toEqual(['frag']);
  });

  it('keeps same-named struct members scoped to their nearest Pass-local struct', () => {
    const idx: FileIndex = {
      uri: 'file:///t/m.shader',
      symbols: [
        sym('Attributes', 'struct', 5),
        sym('positionOS', 'structMember', 6, 'Attributes'),
        sym('Attributes', 'struct', 25),
        sym('positionCS', 'structMember', 26, 'Attributes'),
      ],
      references: [],
      structure: {
        shaders: [{
          kind: 'shader',
          name: 'X',
          headerLine: 0,
          closeLine: 50,
          children: [{
            kind: 'subshader',
            headerLine: 1,
            closeLine: 49,
            children: [
              { kind: 'pass', name: 'Lit', headerLine: 2, closeLine: 20, children: [] },
              { kind: 'pass', name: 'Shadow', headerLine: 21, closeLine: 48, children: [] },
            ],
          }],
        }],
      },
    };

    const tree = buildDocumentSymbols(idx);

    const passes = tree[0].children?.[0].children ?? [];
    const litAttributes = passes[0].children?.find((node) => node.name === 'Attributes');
    const shadowAttributes = passes[1].children?.find((node) => node.name === 'Attributes');

    expect(passes.map((node) => node.name)).toEqual(['Pass "Lit"', 'Pass "Shadow"']);
    expect(litAttributes?.children?.map((node) => node.name)).toEqual(['positionOS']);
    expect(shadowAttributes?.children?.map((node) => node.name)).toEqual(['positionCS']);
  });
});
