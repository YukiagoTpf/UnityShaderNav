import { describe, expect, it } from 'vitest';
import type { Location } from 'vscode-languageserver/node';
import type { Position } from '@unity-shader-nav/shared';
import { createIncludeChain } from '../../src/include';
import {
  GlobalSymbolIndex,
  IndexStore,
  cursorTargetAt,
  findHighlights,
} from '../../src/index';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

const includeCtx = { unityProjectRoot: undefined, includeDirectories: [] };

async function highlightsAt(uri: string, text: string, position: Position): Promise<Location[]> {
  const index = await indexFile(uri, text);
  const store = new IndexStore();
  store.set(uri, index);
  const global = new GlobalSymbolIndex();
  global.upsert(index);
  const visibleUriKeys = await createIncludeChain(store, includeCtx).visibleUriKeys(uri);
  const target = cursorTargetAt(text, position, { detectIncludes: false });
  return findHighlights(target, { index, position, global, options: { visibleUriKeys } });
}

function tokenPosition(text: string, line: number, token: string, occurrence = 0): Position {
  const lines = text.split(/\r?\n/);
  let character = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    character = lines[line].indexOf(token, from);
    if (character < 0) throw new Error(`missing token ${token} on line ${line}`);
    from = character + token.length;
  }
  return { line, character };
}

function rangeKeys(locations: Location[]): string[] {
  return locations
    .map((location) => {
      const { start, end } = location.range;
      return `${start.line}:${start.character}-${end.line}:${end.character}`;
    })
    .sort();
}

describe('findHighlights', () => {
  it('narrows scoped locals to the active function scope', async () => {
    const uri = 'file:///t/ScopedLocals.hlsl';
    const text = [
      'float First() {',
      '  float i = 1;',
      '  i = i + 1;',
      '  return i;',
      '}',
      'float Second() {',
      '  float i = 2;',
      '  i = i + 1;',
      '  return i;',
      '}',
    ].join('\n');

    const locations = await highlightsAt(uri, text, { line: 2, character: 2 });

    // First.i declaration (line 1) + its three identifier uses (lines 2,2,3),
    // and nothing from Second's scope (lines 6-8).
    expect(locations).toHaveLength(4);
    for (const location of locations) {
      expect(location.range.start.line).toBeGreaterThanOrEqual(1);
      expect(location.range.start.line).toBeLessThanOrEqual(3);
    }
  });

  it('narrows struct members to the receiver type without mixing same-name members', async () => {
    const uri = 'file:///t/MemberHighlights.hlsl';
    const text = [
      'struct InputData { float3 positionWS; };',
      'struct Varyings { float4 positionWS; };',
      'float4 frag(Varyings i) {',
      '  InputData inputData;',
      '  inputData.positionWS = i.positionWS;',
      '  return inputData.positionWS.x + i.positionWS.x;',
      '}',
    ].join('\n');

    const locations = await highlightsAt(uri, text, tokenPosition(text, 4, 'positionWS'));

    // InputData.positionWS declaration (line 0) + the two inputData.positionWS
    // member refs (lines 4,5). Varyings.positionWS and i.positionWS are excluded.
    expect(locations).toHaveLength(3);
    expect(rangeKeys(locations)).toContain(
      `0:${'struct InputData { float3 '.length}-0:${'struct InputData { float3 '.length + 'positionWS'.length}`,
    );
  });

  it('collects a global function declaration and its same-file calls', async () => {
    const uri = 'file:///t/Functions.hlsl';
    const text = [
      'float4 Helper() { return 1; }',
      'float4 Main() { return Helper(); }',
    ].join('\n');

    const locations = await highlightsAt(uri, text, tokenPosition(text, 1, 'Helper'));

    // Declaration (line 0) from the global symbol index + the call (line 1) from
    // the file references, kind-aware narrowed to the function target.
    expect(locations).toHaveLength(2);
    expect(rangeKeys(locations)).toEqual([
      `0:7-0:13`,
      `1:${text.split('\n')[1].indexOf('Helper')}-1:${text.split('\n')[1].indexOf('Helper') + 6}`,
    ].sort());
  });

  it('falls back to same-receiver member highlights when the member declaration is missing', async () => {
    const uri = 'file:///t/ExternalMemberHighlights.hlsl';
    const text = [
      'struct Varyings { float4 positionWS; };',
      'float4 frag(Varyings i) {',
      '  InputData inputData;',
      '  inputData = (InputData)0;',
      '  inputData.positionWS = i.positionWS;',
      '  inputData.shadowCoord = TransformWorldToShadowCoord(i.positionWS);',
      '  return inputData.positionWS.x;',
      '}',
    ].join('\n');

    const locations = await highlightsAt(uri, text, tokenPosition(text, 4, 'positionWS'));

    // InputData has no struct declaration, so the member resolves to nothing and
    // the fallback highlights every inputData.positionWS occurrence (lines 4,6) —
    // never i.positionWS.
    expect(rangeKeys(locations)).toEqual([
      `4:${'  inputData.'.length}-4:${'  inputData.'.length + 'positionWS'.length}`,
      `6:${'  return inputData.'.length}-6:${'  return inputData.'.length + 'positionWS'.length}`,
    ].sort());
  });

  it('dedupes the declaration and reference set', async () => {
    const uri = 'file:///t/Dedupe.hlsl';
    const text = [
      'float4 Helper() { return 1; }',
      'float4 Main() { return Helper() + Helper(); }',
    ].join('\n');

    const locations = await highlightsAt(uri, text, tokenPosition(text, 0, 'Helper'));

    // Declaration + two distinct call sites, with no duplicate ranges.
    const keys = rangeKeys(locations);
    expect(new Set(keys).size).toBe(keys.length);
    expect(locations).toHaveLength(3);
  });
});

describe('findHighlights with VariantContext', () => {
  // Fixture: two same-name functions in opposite #ifdef branches, each with a
  // call in its own branch. indexFile flattens both branches (ADR-0001); the
  // variant filter narrows to the active branch at resolution time.
  // Line 0: #pragma multi_compile _ FOO BAR
  // Line 1: #ifdef FOO
  // Line 2:   float4 Helper() { return 1.0; }   (decl A)
  // Line 3:   void UseA() { Helper(); }          (ref A)
  // Line 4: #endif
  // Line 5: #ifdef BAR
  // Line 6:   float4 Helper() { return 2.0; }   (decl B)
  // Line 7:   void UseB() { Helper(); }          (ref B)
  // Line 8: #endif
  const text = [
    '#pragma multi_compile _ FOO BAR', // 0
    '#ifdef FOO', // 1
    'float4 Helper() { return 1.0; }', // 2
    'void UseA() { Helper(); }', // 3
    '#endif', // 4
    '#ifdef BAR', // 5
    'float4 Helper() { return 2.0; }', // 6
    'void UseB() { Helper(); }', // 7
    '#endif', // 8
  ].join('\n');

  const uri = 'file:///t/VariantHighlights.hlsl';

  async function highlightsWithVariant(
    text: string,
    uri: string,
    position: Position,
    variantContext?: { activeKeywords: ReadonlySet<string> },
    getText?: (uri: string) => string | undefined,
  ): Promise<Location[]> {
    const index = await indexFile(uri, text);
    const store = new IndexStore();
    store.set(uri, index);
    const global = new GlobalSymbolIndex();
    global.upsert(index);
    const visibleUriKeys = await createIncludeChain(store, includeCtx).visibleUriKeys(uri);
    const target = cursorTargetAt(text, position, { detectIncludes: false });
    return findHighlights(target, {
      index,
      position,
      global,
      options: { visibleUriKeys },
      variantContext,
      getText,
    });
  }

  function lineNumbers(locations: Location[]): number[] {
    return locations.map((l) => l.range.start.line).sort((a, b) => a - b);
  }

  it('returns only the active branch declaration + references when one branch is active', async () => {
    // FOO active → #ifdef FOO branch (lines 2,3) active; #ifdef BAR inactive.
    const position = tokenPosition(text, 2, 'Helper');
    const locations = await highlightsWithVariant(
      text,
      uri,
      position,
      { activeKeywords: new Set(['FOO']) },
      () => text,
    );
    expect(lineNumbers(locations)).toEqual([2, 3]);
  });

  it('returns only the other branch when FOO is inactive and BAR is active', async () => {
    // BAR active → #ifdef BAR branch (lines 6,7) active; #ifdef FOO inactive.
    const position = tokenPosition(text, 2, 'Helper');
    const locations = await highlightsWithVariant(
      text,
      uri,
      position,
      { activeKeywords: new Set(['BAR']) },
      () => text,
    );
    expect(lineNumbers(locations)).toEqual([6, 7]);
  });

  it('returns every active location when multiple branches remain active', async () => {
    // Ungated decl+call (always active) + FOO-gated decl+call (active with FOO).
    const textMulti = [
      '#pragma multi_compile _ FOO', // 0
      'float4 Helper() { return 1.0; }', // 1
      'void Use() { Helper(); }', // 2
      '#ifdef FOO', // 3
      'float4 Helper() { return 2.0; }', // 4
      'void Use2() { Helper(); }', // 5
      '#endif', // 6
    ].join('\n');
    const uriMulti = 'file:///t/VariantHighlightsMulti.hlsl';
    const position = tokenPosition(textMulti, 1, 'Helper');
    const locations = await highlightsWithVariant(
      textMulti,
      uriMulti,
      position,
      { activeKeywords: new Set(['FOO']) },
      () => textMulti,
    );
    // All four locations are active (lines 1,2 ungated + lines 4,5 FOO-gated
    // but active) → nothing dropped.
    expect(lineNumbers(locations)).toEqual([1, 2, 4, 5]);
  });

  it('falls back to all locations when the context rules out every branch', async () => {
    // Neither FOO nor BAR active (BAZ is) → both branches provably inactive →
    // zero eligible → conservative fallback returns all four locations.
    const position = tokenPosition(text, 2, 'Helper');
    const locations = await highlightsWithVariant(
      text,
      uri,
      position,
      { activeKeywords: new Set(['BAZ']) },
      () => text,
    );
    expect(lineNumbers(locations)).toEqual([2, 3, 6, 7]);
  });

  it('returns all locations when no variantContext is supplied (unchanged behaviour)', async () => {
    const position = tokenPosition(text, 2, 'Helper');
    const locations = await highlightsWithVariant(text, uri, position);
    expect(lineNumbers(locations)).toEqual([2, 3, 6, 7]);
  });

  it('returns all locations when getText is not supplied (conservative — cannot evaluate)', async () => {
    // variantContext present but no getText → cannot evaluate branch activity
    // → every location kept, identical to no-context behaviour.
    const position = tokenPosition(text, 2, 'Helper');
    const locations = await highlightsWithVariant(
      text,
      uri,
      position,
      { activeKeywords: new Set(['FOO']) },
    );
    expect(lineNumbers(locations)).toEqual([2, 3, 6, 7]);
  });
});
