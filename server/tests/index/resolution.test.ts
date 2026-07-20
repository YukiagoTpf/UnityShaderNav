import { describe, expect, it } from 'vitest';
import type { FileIndex, Position, Range, SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex } from '../../src/index/globalIndex';
import type { CursorTarget } from '../../src/index/cursorTarget';
import type { IncludeDirective } from '../../src/parser/include/lineScanner';
import type { WordAt } from '../../src/parser/lexical/cursor';
import { resolveDefinition, type ResolverContext } from '../../src/index/resolution';

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

describe('resolveDefinition dispatch', () => {
  it('symbol target resolves to a matching global variable', () => {
    const gColor = sym({
      name: 'gColor',
      kind: 'variable',
      location: { uri, range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } } },
    });
    const idx: FileIndex = { uri, references: [], symbols: [gColor] };

    const target: CursorTarget = { kind: 'symbol', word: word('gColor') };
    const result = resolveDefinition(target, ctxFor(idx, { line: 5, character: 2 }));

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
    const result = resolveDefinition(target, ctxFor(idx, { line: 5, character: 2 }));

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
    const result = resolveDefinition(target, ctxFor(idx, { line: 5, character: 2 }));

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
    const result = resolveDefinition(target, ctxFor(idx, { line: 5, character: 2 }));

    expect(result).toEqual([]);
  });

  it('none target returns no candidates', () => {
    const idx: FileIndex = { uri, references: [], symbols: [sym({ name: 'gColor', kind: 'variable' })] };

    const target: CursorTarget = { kind: 'none' };
    const result = resolveDefinition(target, ctxFor(idx, { line: 0, character: 0 }));

    expect(result).toEqual([]);
  });

  it('include target returns no candidates', () => {
    const idx: FileIndex = { uri, references: [], symbols: [sym({ name: 'gColor', kind: 'variable' })] };

    const include: IncludeDirective = { line: 0, path: 'Common.hlsl', pathRange: zeroRange };
    const target: CursorTarget = { kind: 'include', include };
    const result = resolveDefinition(target, ctxFor(idx, { line: 0, character: 0 }));

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
    const result = resolveDefinition(target, ctxFor(idx, { line: 12, character: 1 }, global));

    expect(result).toHaveLength(2);
    const uris = result.map((s) => s.location.uri).sort();
    expect(uris).toEqual([otherUri, uri].sort());
  });
});

describe('resolveDefinition with VariantContext', () => {
  // Fixture A: two same-name variables in opposite #ifdef branches.
  // Line 0: #pragma multi_compile _ FOO
  // Line 1: #ifdef FOO
  // Line 2:   int gColor;   (symA)
  // Line 3: #else
  // Line 4:   int gColor;   (symB)
  // Line 5: #endif
  const text = [
    '#pragma multi_compile _ FOO', // 0
    '#ifdef FOO', // 1
    'int gColor;', // 2
    '#else', // 3
    'int gColor;', // 4
    '#endif', // 5
  ].join('\n');

  const symA = sym({
    name: 'gColor',
    kind: 'variable',
    location: { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } },
  });
  const symB = sym({
    name: 'gColor',
    kind: 'variable',
    location: { uri, range: { start: { line: 4, character: 4 }, end: { line: 4, character: 10 } } },
  });
  const idx: FileIndex = { uri, references: [], symbols: [symA, symB] };
  const target: CursorTarget = { kind: 'symbol', word: word('gColor') };

  it('returns only the active candidate when one branch is active (no Peek)', () => {
    // FOO active → #ifdef FOO branch active, #else provably inactive.
    const ctx: ResolverContext = {
      index: idx,
      global: null,
      position: { line: 10, character: 0 },
      variantContext: { activeKeywords: new Set(['FOO']) },
      getText: () => text,
    };
    const result = resolveDefinition(target, ctx);
    expect(result).toEqual([symA]);
  });

  it('returns only the else-branch candidate when FOO is inactive', () => {
    // FOO not in the active set (BAR is) → #ifdef FOO provably inactive,
    // #else active.
    const ctx: ResolverContext = {
      index: idx,
      global: null,
      position: { line: 10, character: 0 },
      variantContext: { activeKeywords: new Set(['BAR']) },
      getText: () => text,
    };
    const result = resolveDefinition(target, ctx);
    expect(result).toEqual([symB]);
  });

  it('returns every eligible candidate when multiple branches remain active', () => {
    // One ungated symbol (always active) + one FOO-gated symbol (active when
    // FOO is on). Both eligible → both returned; nothing dropped.
    const textMulti = [
      '#pragma multi_compile _ FOO', // 0
      'int gColor;', // 1 — always active
      '#ifdef FOO', // 2
      'int gColor;', // 3 — active when FOO on
      '#endif', // 4
    ].join('\n');
    const symAlways = sym({
      name: 'gColor',
      kind: 'variable',
      location: { uri, range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } } },
    });
    const symGated = sym({
      name: 'gColor',
      kind: 'variable',
      location: { uri, range: { start: { line: 3, character: 4 }, end: { line: 3, character: 10 } } },
    });
    const idxMulti: FileIndex = { uri, references: [], symbols: [symAlways, symGated] };
    const ctx: ResolverContext = {
      index: idxMulti,
      global: null,
      position: { line: 10, character: 0 },
      variantContext: { activeKeywords: new Set(['FOO']) },
      getText: () => textMulti,
    };
    const result = resolveDefinition(target, ctx);
    expect(result).toEqual([symAlways, symGated]);
  });

  it('falls back to all candidates when the context rules out every branch', () => {
    // Both candidates behind distinct variant branches, neither active.
    const textZero = [
      '#pragma multi_compile _ FOO BAR', // 0
      '#ifdef FOO', // 1
      'int gColor;', // 2
      '#endif', // 3
      '#ifdef BAR', // 4
      'int gColor;', // 5
      '#endif', // 6
    ].join('\n');
    const symF = sym({
      name: 'gColor',
      kind: 'variable',
      location: { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } },
    });
    const symBar = sym({
      name: 'gColor',
      kind: 'variable',
      location: { uri, range: { start: { line: 5, character: 4 }, end: { line: 5, character: 10 } } },
    });
    const idxZero: FileIndex = { uri, references: [], symbols: [symF, symBar] };
    // BAZ active → neither FOO nor BAR active → both branches provably
    // inactive → zero eligible → conservative fallback returns all.
    const ctx: ResolverContext = {
      index: idxZero,
      global: null,
      position: { line: 10, character: 0 },
      variantContext: { activeKeywords: new Set(['BAZ']) },
      getText: () => textZero,
    };
    const result = resolveDefinition(target, ctx);
    expect(result).toHaveLength(2);
  });

  it('keeps a cross-file candidate whose URI text cannot be retrieved (not dropped)', () => {
    // symA lives in the #ifdef FOO branch (text available → provably inactive
    // when FOO is off); otherSym lives in another URI whose text getText cannot
    // supply → treated as eligible, never dropped by mistake.
    const otherUri = 'file:///t/other.hlsl';
    const otherSym = sym({
      name: 'gColor',
      kind: 'variable',
      location: { uri: otherUri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } } },
    });
    const global = new GlobalSymbolIndex();
    global.upsert({ uri: otherUri, references: [], symbols: [otherSym] });
    const idxCross: FileIndex = { uri, references: [], symbols: [symA] };
    const ctx: ResolverContext = {
      index: idxCross,
      global,
      position: { line: 10, character: 0 },
      variantContext: { activeKeywords: new Set(['BAR']) },
      getText: (u) => (u === uri ? text : undefined),
    };
    const result = resolveDefinition(target, ctx);
    expect(result).toEqual([otherSym]);
  });

  it('returns all candidates when no variantContext is supplied (unchanged behaviour)', () => {
    const ctx: ResolverContext = {
      index: idx,
      global: null,
      position: { line: 10, character: 0 },
    };
    const result = resolveDefinition(target, ctx);
    expect(result).toHaveLength(2);
  });

  it('returns all candidates when getText is not supplied (conservative — cannot evaluate)', () => {
    const ctx: ResolverContext = {
      index: idx,
      global: null,
      position: { line: 10, character: 0 },
      variantContext: { activeKeywords: new Set(['FOO']) },
    };
    const result = resolveDefinition(target, ctx);
    expect(result).toHaveLength(2);
  });

  it('judges isShaderLab per URI so a .shader origin does not keep an inactive .hlsl candidate', () => {
    // Regression: the resolver once threaded a single document-level
    // `isShaderLab` flag across every candidate URI. A .shader origin set the
    // flag true, and a plain .hlsl candidate (no HLSLPROGRAM/CGPROGRAM block)
    // was then scanned with isShaderLab=true → scanBlocks found no blocks → no
    // inactive regions → its #ifdef-gated line was misjudged active and the
    // candidate was wrongly kept. isShaderLab is now resolved per URI.
    //
    // .shader origin: gColor is always active inside an HLSLPROGRAM block.
    const shaderUri = 'file:///t/Mixed.shader';
    const shaderText = [
      'Shader "Mixed" {', // 0
      '  HLSLPROGRAM', // 1
      '  #pragma multi_compile _ FOO', // 2
      '  float4 gColor;', // 3
      '  ENDHLSL', // 4
      '}', // 5
    ].join('\n');
    // .hlsl cross-file candidate: gColor lives behind #ifdef FOO.
    const hlslUri = 'file:///t/Mixed.hlsl';
    const hlslText = [
      '#pragma multi_compile _ FOO', // 0
      '#ifdef FOO', // 1
      'float4 gColor;', // 2
      '#endif', // 3
    ].join('\n');

    const shaderSym = sym({
      name: 'gColor',
      kind: 'variable',
      location: {
        uri: shaderUri,
        range: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } },
      },
    });
    const hlslSym = sym({
      name: 'gColor',
      kind: 'variable',
      location: {
        uri: hlslUri,
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } },
      },
    });

    const global = new GlobalSymbolIndex();
    global.upsert({ uri: hlslUri, references: [], symbols: [hlslSym] });
    const idxMixed: FileIndex = { uri: shaderUri, references: [], symbols: [shaderSym] };

    // BAR active → FOO inactive everywhere. The legacy isShaderLab flag is left
    // on the context object (callers may still pass it); the resolver ignores it
    // and judges each candidate by its own URI kind.
    const ctx: ResolverContext & { isShaderLab?: boolean } = {
      index: idxMixed,
      global,
      position: { line: 10, character: 0 },
      variantContext: { activeKeywords: new Set(['BAR']) },
      getText: (u) => (u === shaderUri ? shaderText : u === hlslUri ? hlslText : undefined),
      isShaderLab: true,
    };
    const result = resolveDefinition(target, ctx);
    // Only the .shader candidate survives: the .hlsl candidate lives in an
    // inactive #ifdef FOO branch, correctly evaluated with isShaderLab=false.
    expect(result).toEqual([shaderSym]);
  });
});
