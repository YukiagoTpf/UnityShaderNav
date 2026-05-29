import { describe, expect, it } from 'vitest';
import type { FileIndex, Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex } from '../../src/index/globalIndex';
import type { CursorTarget, WordAt } from '../../src/index/cursorTarget';
import type { IncludeDirective } from '../../src/parser/include/lineScanner';
import { resolveTarget, type ResolverContext } from '../../src/index/resolveTarget';

const uri = 'file:///t/main.hlsl';

const zeroRange: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function sym(over: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return {
    location: { uri, range: zeroRange },
    ...over,
  } as SymbolEntry;
}

function word(text: string): WordAt {
  return { text, range: zeroRange };
}

function ctxFor(index: FileIndex, position: Position, global: GlobalSymbolIndex | null = null): ResolverContext {
  return { index, global, position };
}

describe('resolveTarget dispatch', () => {
  it('symbol target resolves to a matching global variable', () => {
    const gColor = sym({
      name: 'gColor',
      kind: 'variable',
      location: { uri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } } },
    });
    const idx: FileIndex = { uri, references: [], symbols: [gColor] };

    const target: CursorTarget = { kind: 'symbol', word: word('gColor') };
    const result = resolveTarget(target, ctxFor(idx, { line: 5, character: 2 }));

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(gColor);
  });

  it('member target resolves to the struct member of the receiver type', () => {
    const memberRange: Range = { start: { line: 1, character: 8 }, end: { line: 1, character: 9 } };
    const member = sym({
      name: 'a',
      kind: 'structMember',
      parentType: 'S',
      location: { uri, range: memberRange },
    });
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 's',
          kind: 'variable',
          declaredType: 'S',
          location: { uri, range: { start: { line: 3, character: 2 }, end: { line: 3, character: 3 } } },
        }),
        sym({ name: 'S', kind: 'struct', location: { uri, range: zeroRange } }),
        member,
      ],
    };

    const target: CursorTarget = { kind: 'member', receiver: word('s'), member: word('a') };
    const result = resolveTarget(target, ctxFor(idx, { line: 5, character: 2 }));

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(member);
  });

  it('member target with an unknown receiver type returns no candidates', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [sym({ name: 'a', kind: 'structMember', parentType: 'S', location: { uri, range: zeroRange } })],
    };

    // `s` is never declared, so its receiver type cannot be inferred.
    const target: CursorTarget = { kind: 'member', receiver: word('s'), member: word('a') };
    const result = resolveTarget(target, ctxFor(idx, { line: 5, character: 2 }));

    expect(result).toEqual([]);
  });

  it('member target whose receiver type resolves but member name is absent returns no candidates (no fall-through)', () => {
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        sym({
          name: 's',
          kind: 'variable',
          declaredType: 'S',
          location: { uri, range: { start: { line: 3, character: 2 }, end: { line: 3, character: 3 } } },
        }),
        sym({ name: 'S', kind: 'struct', location: { uri, range: zeroRange } }),
        sym({ name: 'a', kind: 'structMember', parentType: 'S', location: { uri, range: zeroRange } }),
      ],
    };

    // Receiver `s` resolves to type `S`, but `S` has no member named `missing`.
    const target: CursorTarget = { kind: 'member', receiver: word('s'), member: word('missing') };
    const result = resolveTarget(target, ctxFor(idx, { line: 5, character: 2 }));

    expect(result).toEqual([]);
  });

  it('none target returns no candidates', () => {
    const idx: FileIndex = { uri, references: [], symbols: [sym({ name: 'gColor', kind: 'variable' })] };

    const target: CursorTarget = { kind: 'none' };
    const result = resolveTarget(target, ctxFor(idx, { line: 0, character: 0 }));

    expect(result).toEqual([]);
  });

  it('include target returns no candidates', () => {
    const idx: FileIndex = { uri, references: [], symbols: [sym({ name: 'gColor', kind: 'variable' })] };

    const include: IncludeDirective = { line: 0, path: 'Common.hlsl', pathRange: zeroRange };
    const target: CursorTarget = { kind: 'include', include };
    const result = resolveTarget(target, ctxFor(idx, { line: 0, character: 0 }));

    expect(result).toEqual([]);
  });

  it('symbol target returns every same-name global candidate (ADR-0001 multi-candidate)', () => {
    const fileGlobal = sym({
      name: 'vert',
      kind: 'function',
      location: { uri, range: { start: { line: 10, character: 0 }, end: { line: 10, character: 4 } } },
    });
    const idx: FileIndex = { uri, references: [], symbols: [fileGlobal] };

    const global = new GlobalSymbolIndex();
    const otherUri = 'file:///t/other.hlsl';
    global.upsert({
      uri: otherUri,
      references: [],
      symbols: [
        sym({
          name: 'vert',
          kind: 'function',
          location: { uri: otherUri, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } } },
        }),
      ],
    });

    const target: CursorTarget = { kind: 'symbol', word: word('vert') };
    const result = resolveTarget(target, ctxFor(idx, { line: 12, character: 1 }, global));

    expect(result).toHaveLength(2);
    const uris = result.map((s) => s.location.uri).sort();
    expect(uris).toEqual([otherUri, uri].sort());
  });
});
