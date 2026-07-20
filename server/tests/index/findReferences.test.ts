import { describe, expect, it } from 'vitest';
import {
  LSPErrorCodes,
  type CancellationToken,
  type Location,
} from 'vscode-languageserver/node';
import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import type { Position } from '@unity-shader-nav/shared';
import { createIncludeChain } from '../../src/include';
import {
  GlobalReferenceIndex,
  GlobalSymbolIndex,
  IndexStore,
  cursorTargetAt,
  findReferences,
} from '../../src/index';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

const includeCtx = { unityProjectRoot: undefined, includeDirectories: [] };

async function setup(uri: string, text: string) {
  const index = await indexFile(uri, text);
  const store = new IndexStore();
  store.set(uri, index);
  const global = new GlobalSymbolIndex();
  const globalRefs = new GlobalReferenceIndex();
  global.upsert(index);
  globalRefs.upsert(index);
  return { index, store, global, globalRefs };
}

function referencesAt(
  base: Awaited<ReturnType<typeof setup>>,
  position: Position,
  includeDeclaration: boolean,
  text: string,
  cancellation?: CancellationToken,
): Promise<Location[]> {
  const target = cursorTargetAt(text, position, { detectIncludes: false });
  return findReferences(target, {
    index: base.index,
    position,
    global: base.global,
    globalRefs: base.globalRefs,
    store: base.store,
    includeChain: createIncludeChain(base.store, includeCtx),
    isInPackages: () => false,
    includePackages: true,
    includeDeclaration,
    cancellation,
  });
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

describe('findReferences', () => {
  it('observes cancellation during a large reference scan', async () => {
    const uri = 'file:///t/LongRefs.hlsl';
    const text = [
      'float4 Helper() { return 1; }',
      'float4 Main() {',
      ...Array.from({ length: 4096 }, () => '  Helper();'),
      '}',
    ].join('\n');
    const base = await setup(uri, text);
    const cancellation = new CancellationTokenSource();
    const cancellationTask = setImmediate(() => cancellation.cancel());

    try {
      await expect(referencesAt(
        base,
        tokenPosition(text, 0, 'Helper'),
        true,
        text,
        cancellation.token,
      )).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    } finally {
      clearImmediate(cancellationTask);
      cancellation.dispose();
    }
  });

  it('collects same-file function calls, gated by includeDeclaration', async () => {
    const uri = 'file:///t/Refs.hlsl';
    const text = [
      'float4 Helper() { return 1; }',
      'float4 Main() { return Helper() + Helper(); }',
    ].join('\n');
    const base = await setup(uri, text);
    const position = tokenPosition(text, 1, 'Helper');

    const withDeclaration = await referencesAt(base, position, true, text);
    // declaration (line 0) + the two calls (line 1).
    expect(withDeclaration).toHaveLength(3);

    const withoutDeclaration = await referencesAt(base, position, false, text);
    // only the two call sites, no declaration.
    expect(withoutDeclaration).toHaveLength(2);
    for (const location of withoutDeclaration) {
      expect(location.range.start.line).toBe(1);
    }
  });

  it('uses the declaration kind to disambiguate same-name global symbols', async () => {
    const uri = 'file:///t/KindAwareRefs.hlsl';
    const text = [
      'float Shared;',
      'float Shared() { return 0; }',
      'float UseVariable() { return Shared; }',
      'float UseFunction() { return Shared(); }',
    ].join('\n');
    const base = await setup(uri, text);

    const refs = await referencesAt(
      base,
      tokenPosition(text, 0, 'Shared'),
      true,
      text,
    );

    expect(refs.map((location) => location.range.start.line)).toEqual([0, 2]);
  });

  it('narrows scoped locals to the active function scope', async () => {
    const uri = 'file:///t/ScopedRefs.hlsl';
    const text = [
      'float First() {',
      '  float i = 1;',
      '  return i;',
      '}',
      'float Second() {',
      '  float i = 2;',
      '  return i;',
      '}',
    ].join('\n');
    const base = await setup(uri, text);
    const position = tokenPosition(text, 2, 'i');

    const refs = await referencesAt(base, position, true, text);

    // First.i declaration (line 1) + use (line 2); nothing from Second (lines 5-6).
    expect(refs.length).toBeGreaterThan(0);
    for (const location of refs) {
      expect(location.range.start.line).toBeGreaterThanOrEqual(1);
      expect(location.range.start.line).toBeLessThanOrEqual(2);
    }
  });
});

describe('findReferences with VariantContext', () => {
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

  const uri = 'file:///t/VariantRefs.hlsl';

  async function referencesWithVariant(
    text: string,
    uri: string,
    position: Position,
    includeDeclaration: boolean,
    variantContext?: { activeKeywords: ReadonlySet<string> },
    getText?: (uri: string) => string | undefined,
  ): Promise<Location[]> {
    const base = await setup(uri, text);
    const target = cursorTargetAt(text, position, { detectIncludes: false });
    return findReferences(target, {
      index: base.index,
      position,
      global: base.global,
      globalRefs: base.globalRefs,
      store: base.store,
      includeChain: createIncludeChain(base.store, includeCtx),
      isInPackages: () => false,
      includePackages: true,
      includeDeclaration,
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
    const refs = await referencesWithVariant(
      text,
      uri,
      position,
      true,
      { activeKeywords: new Set(['FOO']) },
      () => text,
    );
    expect(lineNumbers(refs)).toEqual([2, 3]);
  });

  it('returns only the other branch when FOO is inactive and BAR is active', async () => {
    // BAR active → #ifdef BAR branch (lines 6,7) active; #ifdef FOO inactive.
    const position = tokenPosition(text, 2, 'Helper');
    const refs = await referencesWithVariant(
      text,
      uri,
      position,
      true,
      { activeKeywords: new Set(['BAR']) },
      () => text,
    );
    expect(lineNumbers(refs)).toEqual([6, 7]);
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
    const uriMulti = 'file:///t/VariantRefsMulti.hlsl';
    const position = tokenPosition(textMulti, 1, 'Helper');
    const refs = await referencesWithVariant(
      textMulti,
      uriMulti,
      position,
      true,
      { activeKeywords: new Set(['FOO']) },
      () => textMulti,
    );
    // All four locations are active (lines 1,2 ungated + lines 4,5 FOO-gated
    // but active) → nothing dropped.
    expect(lineNumbers(refs)).toEqual([1, 2, 4, 5]);
  });

  it('falls back to all locations when the context rules out every branch', async () => {
    // Neither FOO nor BAR active (BAZ is) → both branches provably inactive →
    // zero eligible → conservative fallback returns all four locations.
    const position = tokenPosition(text, 2, 'Helper');
    const refs = await referencesWithVariant(
      text,
      uri,
      position,
      true,
      { activeKeywords: new Set(['BAZ']) },
      () => text,
    );
    expect(lineNumbers(refs)).toEqual([2, 3, 6, 7]);
  });

  it('returns all locations when no variantContext is supplied (unchanged behaviour)', async () => {
    const position = tokenPosition(text, 2, 'Helper');
    const refs = await referencesWithVariant(text, uri, position, true);
    expect(lineNumbers(refs)).toEqual([2, 3, 6, 7]);
  });

  it('returns all locations when getText is not supplied (conservative — cannot evaluate)', async () => {
    // variantContext present but no getText → cannot evaluate branch activity
    // → every location kept, identical to no-context behaviour.
    const position = tokenPosition(text, 2, 'Helper');
    const refs = await referencesWithVariant(
      text,
      uri,
      position,
      true,
      { activeKeywords: new Set(['FOO']) },
    );
    expect(lineNumbers(refs)).toEqual([2, 3, 6, 7]);
  });
});
