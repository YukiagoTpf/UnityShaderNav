import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, DefinitionParams, LocationLink } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import {
  GlobalSymbolIndex,
  IndexStore,
  findPropertyCandidatesForName,
  propertyAt,
} from '../../src/index';
import { registerDefinitionHandler } from '../../src/handlers/definition';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';
import { isGenericDefinitionContext } from '../../src/parser/lexical/context';
import { MacroPatternTable } from '../../src/macros/table';
import { uriKey } from '../../src/index/uriKey';

function makeTable(): MacroPatternTable {
  return new MacroPatternTable();
}

interface FixtureFile {
  uri: string;
  languageId: string;
  text: string;
  idx: FileIndex;
}

/**
 * Pair-of-files variant of `definition.test.ts`'s `createDefinitionFixture`
 * (lines 14-51). Mirrors the original fixture shape byte-for-byte (no `settings`,
 * no `reindex`), and pre-populates both the `IndexStore` and the
 * `GlobalSymbolIndex` so visibility-aware resolution sees every test file.
 */
function createPairFixture(
  primary: FixtureFile,
  others: FixtureFile[] = [],
): {
  handler: (params: DefinitionParams) => Promise<unknown>;
  store: IndexStore;
  global: GlobalSymbolIndex;
} {
  let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
  const connection = {
    onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
      handler = fn;
      return { dispose() {} };
    },
    console: {
      warn() {},
    },
  } as unknown as Connection;

  const documentsMap = new Map<string, TextDocument>();
  for (const file of [primary, ...others]) {
    documentsMap.set(file.uri, TextDocument.create(file.uri, file.languageId, 1, file.text));
  }
  const documents = {
    get(requestedUri: string) {
      return documentsMap.get(requestedUri);
    },
  } as never;

  const store = new IndexStore();
  const global = new GlobalSymbolIndex();
  for (const file of [primary, ...others]) {
    store.set(file.uri, file.idx);
    global.upsert(file.idx);
  }

  const workspace = {
    includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
    store,
    global,
  };
  const manager = {
    async workspaceForOrCreateFile(requestedUri: string) {
      return documentsMap.has(requestedUri) ? workspace : undefined;
    },
  } as never;

  registerDefinitionHandler(connection, documents, manager);
  if (!handler) throw new Error('definition handler was not registered');
  return { handler, store, global };
}

function tokenPos(text: string, line: number, token: string, occurrence = 0): { line: number; character: number } {
  const lines = text.split(/\r?\n/);
  let from = 0;
  let character = -1;
  for (let i = 0; i <= occurrence; i++) {
    character = lines[line].indexOf(token, from);
    if (character < 0) throw new Error(`missing token "${token}" on line ${line}`);
    from = character + token.length;
  }
  return { line, character };
}

describe('property bridge unit (propertyAt / findPropertyCandidatesForName)', () => {
  // Case 13 (verification): TEXTURE2D($name) yields kind='variable'.
  it('case 13: TEXTURE2D($name) macro target is kind="variable"', async () => {
    const uri = 'file:///t/case13.shader';
    const text = [
      'Shader "T/Case13" {',
      '  Properties {',
      '    _MainTex ("Base", 2D) = "white" {}',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      TEXTURE2D(_MainTex);',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const macroSymbol = idx.symbols.find((s) => s.name === '_MainTex');
    expect(macroSymbol).toBeDefined();
    expect(macroSymbol?.kind).toBe('variable');
  });

  // Case 14: reverse-direction visibility bypass.
  it('case 14: findPropertyCandidatesForName surfaces every indexed shader', () => {
    const aUri = 'file:///t/case14-a.shader';
    const bUri = 'file:///t/case14-b.shader';
    const store = new IndexStore();
    const aIdx: FileIndex = {
      uri: aUri,
      symbols: [],
      references: [],
      properties: [
        {
          name: '_MainTex',
          nameRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } },
          declarationRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 36 } },
          type: '2D',
        },
      ],
    };
    const bIdx: FileIndex = {
      uri: bUri,
      symbols: [],
      references: [],
      properties: [
        {
          name: '_MainTex',
          nameRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } },
          declarationRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 36 } },
          type: '2D',
        },
      ],
    };
    store.set(aUri, aIdx);
    store.set(bUri, bIdx);

    const hits = findPropertyCandidatesForName('_MainTex', store);
    expect(hits.map((h) => h.uri).sort()).toEqual([aUri, bUri].sort());
    // No visibleUriKeys parameter exists on the function — the bypass is by
    // construction. This test pins that contract.
    expect(hits).toHaveLength(2);
  });

  it('findPropertyCandidatesForName preserves the original URI casing', () => {
    // Regression: IndexStore keys go through uriKey which lowercases the
    // Windows drive letter, so the iterator's storeUri uses `f:` while
    // idx.uri keeps `F:`. Property links must round-trip the same casing
    // as every other LocationLink (which uses symbol.location.uri).
    const originalUri = 'file:///F:/Project/Mixed.shader';
    const store = new IndexStore();
    const idx: FileIndex = {
      uri: originalUri,
      symbols: [],
      references: [],
      properties: [
        {
          name: '_Mixed',
          nameRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } },
          declarationRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 32 } },
          type: 'Float',
        },
      ],
    };
    store.set(originalUri, idx);

    const hits = findPropertyCandidatesForName('_Mixed', store);
    expect(hits).toHaveLength(1);
    expect(hits[0].uri).toBe(originalUri); // exact string equality — not case-folded
  });

  // Case 9: lexical gate regressions, exercised by directly calling
  // isGenericDefinitionContext. The handler path is covered elsewhere.
  it('case 9: isGenericDefinitionContext rejects Tags / Pass header / comment / string in .shader', () => {
    const uri = 'file:///t/case9.shader';
    const text = [
      'Shader "T/Case9" {',
      '  Properties {',
      '    _Foo ("Foo", Float) = 0',
      '  }',
      '  SubShader {',
      '    Tags { "RenderType" = "Opaque" }',
      '    Pass {',
      '      Name "Forward"',
      '      HLSLPROGRAM',
      '      float _Foo;',
      '      // _Foo in a comment',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    // Tags content
    expect(isGenericDefinitionContext(text, { line: 5, character: 13 }, 'shaderlab', uri)).toBe(false);
    // Pass Name string
    expect(isGenericDefinitionContext(text, { line: 7, character: 14 }, 'shaderlab', uri)).toBe(false);
    // Comment inside hlsl block
    expect(isGenericDefinitionContext(text, { line: 10, character: 12 }, 'shaderlab', uri)).toBe(false);
  });

  it('propertyAt returns null when idx.properties is undefined', () => {
    const idx: FileIndex = { uri: 'file:///t/empty.shader', symbols: [], references: [] };
    expect(propertyAt(idx, { line: 0, character: 0 })).toBeNull();
  });

  it('case 9b: handler returns null for a cursor inside Tags { ... }', async () => {
    // Handler-level companion to case 9. The unit pin on
    // isGenericDefinitionContext is a contract test on the gate — this case
    // exercises the actual handler so a future refactor that inlines or
    // short-circuits the gate cannot silently let a Tags cursor through.
    const uri = 'file:///t/case9b.shader';
    const text = [
      'Shader "T/Case9b" {',
      '  Properties {',
      '    _Foo ("Foo", Float) = 0',
      '  }',
      '  SubShader {',
      '    Tags { "RenderType" = "Opaque" }',
      '    Pass { HLSLPROGRAM float _Foo; ENDHLSL }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    // Cursor on `RenderType` inside the Tags block.
    const tagsLine = 5;
    const renderTypeCol = text.split('\n')[tagsLine].indexOf('RenderType');
    const result = await handler({
      textDocument: { uri },
      position: { line: tagsLine, character: renderTypeCol + 2 },
    });
    expect(result).toBeNull();
  });
});

describe('registerDefinitionHandler — properties bridge', () => {
  // Case 1: forward, same-file declaration.
  it('case 1: forward, same-file HLSL declaration', async () => {
    const uri = 'file:///t/case1.shader';
    const text = [
      'Shader "T/Case1" {',
      '  Properties {',
      '    _MainTex ("Base", 2D) = "white" {}',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      TEXTURE2D(_MainTex);',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, '_MainTex'),
    })) as LocationLink[] | null;

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    const target = idx.symbols.find((s) => s.name === '_MainTex' && s.kind === 'variable');
    expect(target).toBeDefined();
    expect(result?.[0].targetUri).toBe(uri);
    expect(result?.[0].targetRange).toEqual(target?.location.range);
    expect(result?.[0].originSelectionRange).toEqual(idx.properties?.[0].nameRange);
  });

  // Case 2: forward, declaration in included .hlsl. Uses _BumpScale to avoid
  // the _MainTex_ST suffix-confusion called out in the plan.
  it('case 2: forward, declaration in included .hlsl (_BumpScale)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-20-case2-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const shaderPath = join(assets, 'Case2.shader');
      const libPath = join(assets, 'Lib.hlsl');
      const shaderText = [
        'Shader "T/Case2" {',
        '  Properties {',
        '    _BumpScale ("Bump", Float) = 1',
        '  }',
        '  SubShader {',
        '    Pass {',
        '      HLSLPROGRAM',
        '      #include "Lib.hlsl"',
        '      ENDHLSL',
        '    }',
        '  }',
        '}',
      ].join('\n');
      const libText = 'float _BumpScale;\n';
      await writeFile(shaderPath, shaderText, 'utf8');
      await writeFile(libPath, libText, 'utf8');

      const shaderUri = pathToFileURL(shaderPath).href;
      const libUri = pathToFileURL(libPath).href;
      const shaderIdx = await indexFile(shaderUri, shaderText, makeTable());
      const libIdx = await indexFile(libUri, libText, makeTable());

      let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
      const connection = {
        onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
          handler = fn;
          return { dispose() {} };
        },
        console: { warn() {} },
      } as unknown as Connection;
      const doc = TextDocument.create(shaderUri, 'shaderlab', 1, shaderText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === shaderUri ? doc : undefined;
        },
      } as never;
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const idx of [shaderIdx, libIdx]) {
        store.set(idx.uri, idx);
        global.upsert(idx);
      }
      const workspace = {
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile() {
          return workspace;
        },
      } as never;
      registerDefinitionHandler(connection, documents, manager);

      const result = (await handler?.({
        textDocument: { uri: shaderUri },
        position: tokenPos(shaderText, 2, '_BumpScale'),
      })) as LocationLink[] | null;

      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result?.[0].targetUri).toBe(libUri);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Case 3: forward, no matching HLSL declaration → null.
  it('case 3: forward, no matching HLSL declaration returns null', async () => {
    const uri = 'file:///t/case3.shader';
    const text = [
      'Shader "T/Case3" {',
      '  Properties {',
      '    _Color ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader { Pass { HLSLPROGRAM ENDHLSL } }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, '_Color'),
    });
    expect(result).toBeNull();
  });

  // Case 4: forward, multiple HLSL declarations of the same name. The plan
  // suggests an `#ifdef`-gated pair, but the HLSL parser does not currently
  // emit symbols inside `#ifdef` branches (preprocessor-naive — see
  // `docs/adr/0001-multi-candidate-resolution.md`). Two same-name globals in
  // sibling Pass blocks exercise the multi-candidate path identically, which
  // is what the bridge filter must preserve.
  it('case 4: forward, multiple HLSL declarations return all candidates', async () => {
    const uri = 'file:///t/case4.shader';
    const text = [
      'Shader "T/Case4" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 _Tint;',
      '      ENDHLSL',
      '    }',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 _Tint;',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, '_Tint'),
    })) as LocationLink[] | null;

    const tintSymbols = idx.symbols.filter((s) => s.name === '_Tint' && s.kind === 'variable');
    expect(tintSymbols.length).toBeGreaterThanOrEqual(2);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(tintSymbols.length);
  });

  // Case 5: cursor on type token ('2D') → null (propertyAt only matches name).
  it('case 5: cursor on property type token returns null', async () => {
    const uri = 'file:///t/case5.shader';
    const text = [
      'Shader "T/Case5" {',
      '  Properties {',
      '    _MainTex ("Base", 2D) = "white" {}',
      '  }',
      '  SubShader { Pass { HLSLPROGRAM TEXTURE2D(_MainTex); ENDHLSL } }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    // `2D` is not a valid identifier start (`/^[A-Za-z_]/`), so wordAt
    // rejects it. The handler falls through to isGenericDefinitionContext,
    // which rejects the cursor (not inside an HLSL block) and returns null.
    const result = await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, '2D'),
    });
    expect(result).toBeNull();
  });

  it('case 5b: cursor on identifier-shaped type token (Color) returns no property link', async () => {
    // Regression sister to case 5: `Color` is a valid identifier under wordAt,
    // so it survives word resolution and reaches findPropertyCandidatesForName.
    // The scanner must not have indexed `Color` as a property name (it's a
    // type, captured by group 4, not group 2). Without this assertion a
    // regression in the property regex could turn `Color` into a phantom
    // property and surface every shader's _BaseColor property here.
    const uri = 'file:///t/case5b.shader';
    const text = [
      'Shader "T/Case5b" {',
      '  Properties {',
      '    _BaseColor ("Tint", Color) = (1,1,1,1)',
      '  }',
      '  SubShader { Pass { HLSLPROGRAM float4 _BaseColor; ENDHLSL } }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, 'Color'),
    })) as LocationLink[] | null;

    // Either null (lexical gate rejects — properties block is outside HLSL)
    // OR a non-null result that contains no link whose targetSelectionRange
    // matches the `Color` token. We assert the property scanner did not pick
    // `Color` up as a property name regardless of which path the handler took.
    if (result !== null) {
      const colorTokenLine = 2;
      const colorStart = text.split('\n')[colorTokenLine].indexOf('Color');
      const offending = result.filter(
        (l) =>
          l.targetSelectionRange.start.line === colorTokenLine
          && l.targetSelectionRange.start.character === colorStart,
      );
      expect(offending).toHaveLength(0);
    }
  });

  // Case 6: reverse, HLSL identifier → property in same shader.
  it('case 6: reverse, HLSL identifier in same shader includes property entry', async () => {
    const uri = 'file:///t/case6.shader';
    const text = [
      'Shader "T/Case6" {',
      '  Properties {',
      '    _MainTex ("Base", 2D) = "white" {}',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      TEXTURE2D(_MainTex);',
      '      float4 frag() { return float4(0,0,0,0); }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 7, '_MainTex'),
    })) as LocationLink[] | null;

    expect(result).not.toBeNull();
    // Expect at least one HLSL link and one property link.
    expect(result!.length).toBeGreaterThanOrEqual(2);
    const propEntry = idx.properties?.[0];
    expect(propEntry).toBeDefined();
    const propertyLink = result!.find(
      (l) => l.targetSelectionRange?.start.line === propEntry!.nameRange.start.line
        && l.targetSelectionRange?.start.character === propEntry!.nameRange.start.character,
    );
    expect(propertyLink).toBeDefined();
    expect(propertyLink?.targetRange).toEqual(propEntry?.declarationRange);
  });

  // Case 7: reverse, HLSL identifier in included .hlsl → property entries
  // from both shader files that share the include.
  it('case 7: reverse, HLSL identifier in include returns both shader properties', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-20-case7-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const shaderAPath = join(assets, 'A.shader');
      const shaderBPath = join(assets, 'B.shader');
      const libPath = join(assets, 'Lib.hlsl');
      const aText = [
        'Shader "T/A" {',
        '  Properties {',
        '    _MainTex ("Base", 2D) = "white" {}',
        '  }',
        '  SubShader { Pass { HLSLPROGRAM',
        '    #include "Lib.hlsl"',
        '  ENDHLSL } }',
        '}',
      ].join('\n');
      const bText = [
        'Shader "T/B" {',
        '  Properties {',
        '    _MainTex ("Base", 2D) = "white" {}',
        '  }',
        '  SubShader { Pass { HLSLPROGRAM',
        '    #include "Lib.hlsl"',
        '  ENDHLSL } }',
        '}',
      ].join('\n');
      const libText = 'TEXTURE2D(_MainTex);\n';
      await writeFile(shaderAPath, aText, 'utf8');
      await writeFile(shaderBPath, bText, 'utf8');
      await writeFile(libPath, libText, 'utf8');

      const aUri = pathToFileURL(shaderAPath).href;
      const bUri = pathToFileURL(shaderBPath).href;
      const libUri = pathToFileURL(libPath).href;
      const aIdx = await indexFile(aUri, aText, makeTable());
      const bIdx = await indexFile(bUri, bText, makeTable());
      const libIdx = await indexFile(libUri, libText, makeTable());

      let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
      const connection = {
        onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
          handler = fn;
          return { dispose() {} };
        },
        console: { warn() {} },
      } as unknown as Connection;
      const libDoc = TextDocument.create(libUri, 'hlsl', 1, libText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === libUri ? libDoc : undefined;
        },
      } as never;
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const idx of [aIdx, bIdx, libIdx]) {
        store.set(idx.uri, idx);
        global.upsert(idx);
      }
      const workspace = {
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile() {
          return workspace;
        },
      } as never;
      registerDefinitionHandler(connection, documents, manager);

      const result = (await handler?.({
        textDocument: { uri: libUri },
        position: tokenPos(libText, 0, '_MainTex'),
      })) as LocationLink[] | null;

      expect(result).not.toBeNull();
      const expectedKeys = new Set([uriKey(aUri), uriKey(bUri)]);
      const propertyTargets = result!.filter((l) => expectedKeys.has(uriKey(l.targetUri)));
      expect(new Set(propertyTargets.map((l) => uriKey(l.targetUri)))).toEqual(expectedKeys);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Case 8: reverse, no shader has a matching property → behavior identical
  // to today (HLSL-only links).
  it('case 8: reverse, no matching property keeps HLSL-only behavior', async () => {
    const uri = 'file:///t/case8.hlsl';
    const text = [
      'float _OnlyHere;',
      'float main() { return _OnlyHere; }',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'hlsl', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 1, '_OnlyHere'),
    })) as LocationLink[] | null;

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result?.[0].targetUri).toBe(uri);
  });

  // Case 10: comment between Properties block and a property line is not picked.
  it('case 10: commented-out property line is not picked up', async () => {
    const uri = 'file:///t/case10.shader';
    const text = [
      'Shader "T/Case10" {',
      '  Properties {',
      '    // _Legacy ("Legacy", 2D) = "white" {}',
      '    _MainTex ("Base", 2D) = "white" {}',
      '  }',
      '  SubShader { Pass { HLSLPROGRAM TEXTURE2D(_MainTex); ENDHLSL } }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    expect(idx.properties?.length).toBe(1);
    expect(idx.properties?.[0].name).toBe('_MainTex');

    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });
    // Cursor on the commented identifier text → not a property hit, and the
    // lexical gate rejects ShaderLab cursors outside HLSL blocks.
    const commentPos = tokenPos(text, 2, '_Legacy');
    const result = await handler({
      textDocument: { uri },
      position: commentPos,
    });
    expect(result).toBeNull();
  });

  // Case 11: property name collides with HLSL function — variable-or-cbuffer
  // filter suppresses the function.
  it('case 11: property collides with HLSL function — function suppressed', async () => {
    const uri = 'file:///t/case11.shader';
    const text = [
      'Shader "T/Case11" {',
      '  Properties {',
      '    _Foo ("Foo", Float) = 0',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float _Foo;',
      '      void _Foo() {}',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, '_Foo'),
    })) as LocationLink[] | null;

    expect(result).not.toBeNull();
    // Every returned link must target a variable, not a function.
    const fooVariable = idx.symbols.find((s) => s.name === '_Foo' && s.kind === 'variable');
    const fooFunction = idx.symbols.find((s) => s.name === '_Foo' && s.kind === 'function');
    expect(fooVariable).toBeDefined();
    expect(fooFunction).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result?.[0].targetRange).toEqual(fooVariable?.location.range);
  });

  // Case 12: property collides with HLSL parameter — only globals returned.
  it('case 12: property collides with HLSL parameter — parameter not surfaced', async () => {
    const uri = 'file:///t/case12.shader';
    const text = [
      'Shader "T/Case12" {',
      '  Properties {',
      '    _MainTex ("Base", 2D) = "white" {}',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      TEXTURE2D(_MainTex);',
      '      void f(float _MainTex) {}',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, '_MainTex'),
    })) as LocationLink[] | null;

    expect(result).not.toBeNull();
    // The parameter sits inside a scopeRange that does not contain the
    // property line position; even before the kind filter, it would not be
    // returned. The kind filter additionally drops `parameter`.
    const variableSymbol = idx.symbols.find((s) => s.name === '_MainTex' && s.kind === 'variable');
    expect(variableSymbol).toBeDefined();
    for (const link of result!) {
      expect(link.targetRange).toEqual(variableSymbol?.location.range);
    }
  });

  // Case 13 (handler integration): forward F12 actually reaches TEXTURE2D(_MainTex).
  it('case 13: forward F12 reaches TEXTURE2D($name) target', async () => {
    const uri = 'file:///t/case13-handler.shader';
    const text = [
      'Shader "T/Case13H" {',
      '  Properties {',
      '    _MainTex ("Base", 2D) = "white" {}',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      TEXTURE2D(_MainTex);',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text, makeTable());
    const { handler } = createPairFixture({ uri, languageId: 'shaderlab', text, idx });

    const result = (await handler({
      textDocument: { uri },
      position: tokenPos(text, 2, '_MainTex'),
    })) as LocationLink[] | null;

    expect(result).toHaveLength(1);
    const target = idx.symbols.find((s) => s.name === '_MainTex' && s.kind === 'variable');
    expect(target).toBeDefined();
    expect(result?.[0].targetRange).toEqual(target?.location.range);
  });

  // Case 14 (handler integration): reverse direction bypasses visibility.
  it('case 14: reverse direction bypasses visibility (handler integration)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-20-case14-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const aPath = join(assets, 'A.shader');
      const bPath = join(assets, 'B.shader');
      const cPath = join(assets, 'C.hlsl');
      // C.hlsl is included by A only, not B.
      const aText = [
        'Shader "T/A" {',
        '  Properties {',
        '    _MainTex ("Base", 2D) = "white" {}',
        '  }',
        '  SubShader { Pass { HLSLPROGRAM',
        '    #include "C.hlsl"',
        '  ENDHLSL } }',
        '}',
      ].join('\n');
      const bText = [
        'Shader "T/B" {',
        '  Properties {',
        '    _MainTex ("Base", 2D) = "white" {}',
        '  }',
        '  SubShader { Pass { HLSLPROGRAM ENDHLSL } }',
        '}',
      ].join('\n');
      const cText = 'float4 _MainTex_Helper;\n';
      await writeFile(aPath, aText, 'utf8');
      await writeFile(bPath, bText, 'utf8');
      await writeFile(cPath, cText, 'utf8');

      const aUri = pathToFileURL(aPath).href;
      const bUri = pathToFileURL(bPath).href;
      const cUri = pathToFileURL(cPath).href;
      const aIdx = await indexFile(aUri, aText, makeTable());
      const bIdx = await indexFile(bUri, bText, makeTable());
      const cIdx = await indexFile(cUri, cText, makeTable());

      let handler: ((params: DefinitionParams) => Promise<unknown>) | undefined;
      const connection = {
        onDefinition(fn: (params: DefinitionParams) => Promise<unknown>) {
          handler = fn;
          return { dispose() {} };
        },
        console: { warn() {} },
      } as unknown as Connection;
      // Cursor lives in C.hlsl on a synthetic `_MainTex` identifier in a doc
      // with that bare word so wordAt can pick it up.
      const cDocText = '_MainTex;\n';
      const cDoc = TextDocument.create(cUri, 'hlsl', 1, cDocText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === cUri ? cDoc : undefined;
        },
      } as never;
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const idx of [aIdx, bIdx, cIdx]) {
        store.set(idx.uri, idx);
        global.upsert(idx);
      }
      const workspace = {
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile() {
          return workspace;
        },
      } as never;
      registerDefinitionHandler(connection, documents, manager);

      const result = (await handler?.({
        textDocument: { uri: cUri },
        position: tokenPos(cDocText, 0, '_MainTex'),
      })) as LocationLink[] | null;

      expect(result).not.toBeNull();
      // Both A and B property entries surface even though B does not include C.hlsl.
      const expectedKeys = new Set([uriKey(aUri), uriKey(bUri)]);
      const propertyTargets = result!.filter((l) => expectedKeys.has(uriKey(l.targetUri)));
      expect(new Set(propertyTargets.map((l) => uriKey(l.targetUri)))).toEqual(expectedKeys);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('propertyAt geometry', () => {
  // Geometry coverage for the bridge's cursor predicate. Migrated from the
  // scanner test file when the duplicate `findPropertyAt` export was removed.
  function makeIdx(line: number, nameStart: number, name: string): FileIndex {
    return {
      uri: 'file:///t/geom.shader',
      symbols: [],
      references: [],
      properties: [
        {
          name,
          nameRange: {
            start: { line, character: nameStart },
            end: { line, character: nameStart + name.length },
          },
          declarationRange: {
            start: { line, character: 0 },
            end: { line, character: nameStart + name.length + 20 },
          },
          type: '2D',
        },
      ],
    };
  }

  const line = 2;
  const nameStart = 4;
  const name = '_MainTex';
  const nameEnd = nameStart + name.length;
  const idx = makeIdx(line, nameStart, name);

  it('matches a cursor inside the property name', () => {
    expect(propertyAt(idx, { line, character: nameStart + 2 })?.name).toBe(name);
  });

  it('matches a cursor at the start of the property name', () => {
    expect(propertyAt(idx, { line, character: nameStart })?.name).toBe(name);
  });

  it('matches a cursor at the end of the property name (inclusive)', () => {
    expect(propertyAt(idx, { line, character: nameEnd })?.name).toBe(name);
  });

  it('returns null for a cursor past the name on the same line', () => {
    expect(propertyAt(idx, { line, character: nameEnd + 1 })).toBeNull();
  });

  it('returns null for a cursor on an adjacent line', () => {
    expect(propertyAt(idx, { line: line - 1, character: nameStart + 1 })).toBeNull();
    expect(propertyAt(idx, { line: line + 1, character: nameStart + 1 })).toBeNull();
  });

  it('returns null when FileIndex.properties is undefined', () => {
    const empty: FileIndex = { uri: 'file:///t/empty.hlsl', symbols: [], references: [] };
    expect(propertyAt(empty, { line: 0, character: 0 })).toBeNull();
  });
});
