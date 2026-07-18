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
