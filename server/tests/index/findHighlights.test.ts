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
