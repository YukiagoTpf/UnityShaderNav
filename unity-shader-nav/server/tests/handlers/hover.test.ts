import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, Hover, HoverParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex, FunctionSymbolEntry, SymbolEntry } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerHoverHandler } from '../../src/handlers/hover';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';
import { BUILTIN_ENTRIES } from '../../src/suggestions/builtins';

type HoverHandler = (params: HoverParams) => Promise<Hover | null>;

interface HoverFixture {
  handler: HoverHandler;
  store: IndexStore;
  global: GlobalSymbolIndex;
}

function makeFixture(uri: string, languageId: string, text: string, idx: FileIndex, folderUri?: string): HoverFixture {
  let handler: HoverHandler | undefined;
  const connection = {
    onHover(fn: HoverHandler) {
      handler = fn;
      return { dispose() {} };
    },
    console: {
      warn() {},
    },
  } as unknown as Connection;
  const doc = TextDocument.create(uri, languageId, 1, text);
  const documents = {
    get(requestedUri: string) {
      return requestedUri === uri ? doc : undefined;
    },
  } as never;
  const store = new IndexStore();
  const global = new GlobalSymbolIndex();
  store.set(uri, idx);
  global.upsert(idx);
  const workspace = {
    folderUri,
    includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
    store,
    global,
  };
  const manager = {
    async workspaceForOrCreateFile(requestedUri: string) {
      return requestedUri === uri ? workspace : undefined;
    },
  } as never;
  registerHoverHandler(connection, documents, manager);
  if (!handler) throw new Error('hover handler was not registered');
  return { handler, store, global };
}

function tokenPosition(text: string, line: number, token: string, occurrence = 0): { line: number; character: number } {
  const lines = text.split(/\r?\n/);
  let character = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    character = lines[line].indexOf(token, from);
    if (character < 0) throw new Error(`missing token ${token} on line ${line}`);
    from = character + token.length;
  }
  return { line, character: character + 1 };
}

describe('registerHoverHandler — project symbols', () => {
  it('hovers a function declared in the same file', async () => {
    const uri = 'file:///t/x.hlsl';
    const text = [
      'float4 Helper(float4 v) { return v; }',
      'float4 main() { return Helper(float4(1,1,1,1)); }',
    ].join('\n');
    const idx = await indexFile(uri, text);
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 1, 'Helper'),
    });

    expect(result).not.toBeNull();
    expect(result?.contents).toMatchObject({ kind: 'markdown' });
    const value = (result?.contents as { value: string }).value;
    expect(value).toContain('```hlsl');
    expect(value).toContain('float4 Helper(float4 v)');
    expect(value).toContain('_in_');
    expect(result?.range).toEqual({
      start: { line: 1, character: 23 },
      end: { line: 1, character: 29 },
    });
  });

  it('hovers a function across a #include chain and respects include visibility', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-issue-18-hover-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.hlsl');
      const sharedPath = join(assets, 'Shared.hlsl');
      const otherPath = join(assets, 'Other.hlsl');
      const mainText = [
        '#include "Shared.hlsl"',
        'float4 Main() { return Helper(); }',
      ].join('\n');
      const sharedText = 'float4 Helper() { return 1; }';
      const otherText = 'float4 Helper() { return 2; }';
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(sharedPath, sharedText, 'utf8');
      await writeFile(otherPath, otherText, 'utf8');

      const mainUri = pathToFileURL(mainPath).href;
      const sharedUri = pathToFileURL(sharedPath).href;
      const otherUri = pathToFileURL(otherPath).href;
      const folderUri = pathToFileURL(root).href;
      const indexes = await Promise.all([
        indexFile(mainUri, mainText),
        indexFile(sharedUri, sharedText),
        indexFile(otherUri, otherText),
      ]);
      const store = new IndexStore();
      const global = new GlobalSymbolIndex();
      for (const idx of indexes) {
        store.set(idx.uri, idx);
        global.upsert(idx);
      }

      let handler: HoverHandler | undefined;
      const connection = {
        onHover(fn: HoverHandler) {
          handler = fn;
          return { dispose() {} };
        },
        console: { warn() {} },
      } as unknown as Connection;
      const doc = TextDocument.create(mainUri, 'hlsl', 1, mainText);
      const documents = {
        get(requestedUri: string) {
          return requestedUri === mainUri ? doc : undefined;
        },
      } as never;
      const workspace = {
        folderUri,
        includeCtx: { unityProjectRoot: root, includeDirectories: [] },
        store,
        global,
      };
      const manager = {
        async workspaceForOrCreateFile() {
          return workspace;
        },
      } as never;
      registerHoverHandler(connection, documents, manager);

      const result = await handler?.({
        textDocument: { uri: mainUri },
        position: { line: 1, character: mainText.split('\n')[1].indexOf('Helper') + 1 },
      });

      expect(result).not.toBeNull();
      const value = (result?.contents as { value: string }).value;
      // Single candidate — no `**N candidates**` header.
      expect(value).not.toMatch(/\*\*\d+ candidates\*\*/);
      expect(value).toContain('float4 Helper()');
      // Footer must point at Shared.hlsl, not Other.hlsl.
      expect(value).toContain('Shared.hlsl');
      expect(value).not.toContain('Other.hlsl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hovers a struct member through a known receiver type', async () => {
    const uri = 'file:///t/member.hlsl';
    const text = [
      'struct Surface {',
      '  float3 positionWS;',
      '};',
      'float3 main(Surface surface) { return surface.positionWS; }',
    ].join('\n');
    const idx = await indexFile(uri, text);
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 3, 'positionWS'),
    });

    expect(result).not.toBeNull();
    const value = (result?.contents as { value: string }).value;
    expect(value).toContain('float3 positionWS;');
    expect(value).toContain('_member of_ `Surface`');
  });

  it('hovers a scope-narrowed local variable', async () => {
    const uri = 'file:///t/locals.hlsl';
    const text = [
      'float4 main() {',
      '  float4 myLocal = float4(1, 1, 1, 1);',
      '  return myLocal;',
      '}',
    ].join('\n');
    const idx = await indexFile(uri, text);
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 2, 'myLocal'),
    });

    expect(result).not.toBeNull();
    const value = (result?.contents as { value: string }).value;
    expect(value).toContain('myLocal');
    expect(value).toContain('```hlsl');
  });

  it('hovers a macro definition', async () => {
    const uri = 'file:///t/macro.hlsl';
    const text = [
      '#define MY_THING 1',
      'int useMacro() { return MY_THING; }',
    ].join('\n');
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        {
          name: 'MY_THING',
          kind: 'macro',
          location: { uri, range: { start: { line: 0, character: 8 }, end: { line: 0, character: 16 } } },
        },
        {
          name: 'useMacro',
          kind: 'function',
          returnType: 'int',
          parameters: [],
          location: { uri, range: { start: { line: 1, character: 4 }, end: { line: 1, character: 12 } } },
        } as FunctionSymbolEntry,
      ],
    };
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 1, 'MY_THING'),
    });

    expect(result).not.toBeNull();
    const value = (result?.contents as { value: string }).value;
    expect(value).toContain('#define MY_THING');
  });

  it('renders multiple ambiguous candidates with a header and separator', async () => {
    const uri = 'file:///t/ambiguous.hlsl';
    const text = [
      'float4 ambig() { return 1; }',
      'float4 ambig(float a) { return a; }',
      'float4 caller() { return ambig(2); }',
    ].join('\n');
    const idx = await indexFile(uri, text);
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 2, 'ambig'),
    });

    expect(result).not.toBeNull();
    const value = (result?.contents as { value: string }).value;
    expect(value).toMatch(/^\*\*2 candidates\*\*/);
    expect(value).toContain('\n\n---\n\n');
  });

  it('pins behavior when the cursor sits on the declaration identifier itself', async () => {
    const uri = 'file:///t/self.hlsl';
    const text = 'float4 Helper() { return 0; }';
    const idx = await indexFile(uri, text);
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 0, 'Helper'),
    });

    // Per plan design decision 9: self-hover is allowed; the formatter renders
    // the same card it would for a use-site.
    expect(result).not.toBeNull();
    const value = (result?.contents as { value: string }).value;
    expect(value).toContain('float4 Helper()');
  });

  it('falls through to plain word resolution when member resolution returns empty', async () => {
    // `unknown.x` — receiver type cannot be inferred, so resolveMemberSymbols
    // returns []. Hover must NOT return null; it must fall through to wordAt
    // on `x` (parity with definition.ts:130-150).
    const uri = 'file:///t/member-fallthrough.hlsl';
    const text = [
      'float x = 1;',
      'float main() { return unknown.x; }',
    ].join('\n');
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        {
          name: 'x',
          kind: 'variable',
          declaredType: 'float',
          location: { uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } },
        },
      ],
    };
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const dotIndex = text.split('\n')[1].indexOf('unknown.x') + 'unknown.'.length;
    const result = await handler({
      textDocument: { uri },
      position: { line: 1, character: dotIndex + 1 },
    });

    // Bare `x` resolves to the global float x variable.
    expect(result).not.toBeNull();
    const value = (result?.contents as { value: string }).value;
    expect(value).toContain('float x;');
  });
});

describe('registerHoverHandler — built-in fallback', () => {
  it('hovers a built-in catalog entry when no project symbol matches', async () => {
    const builtin = BUILTIN_ENTRIES.find((entry) => entry.kind === 'function' && entry.category === 'hlsl');
    if (!builtin) throw new Error('expected at least one HLSL built-in function entry in catalog');

    const uri = 'file:///t/builtin.hlsl';
    const text = `float4 use() { return ${builtin.name}(0); }`;
    const idx: FileIndex = { uri, references: [], symbols: [] };
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 0, builtin.name),
    });

    expect(result).not.toBeNull();
    const value = (result?.contents as { value: string }).value;
    expect(value).toContain(builtin.name);
    expect(value).toMatch(/_(HLSL|Unity|URP|ShaderLab) built-in_|_HLSL semantic_/);
  });
});

describe('registerHoverHandler — guards and empty cases', () => {
  it('returns null inside a line comment', async () => {
    const uri = 'file:///t/comment.hlsl';
    const text = [
      'float4 Helper() { return 0; }',
      '// Helper should not hover from a comment',
    ].join('\n');
    const idx = await indexFile(uri, text);
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 1, 'Helper'),
    });

    expect(result).toBeNull();
  });

  it('returns null inside a ShaderLab declarative section (outside any HLSL block)', async () => {
    const uri = 'file:///t/decl.shader';
    const text = [
      'Shader "T/Test" {',
      '  Properties {',
      '    helper ("helper", Float) = 0',
      '  }',
      '  SubShader {',
      '    Pass {',
      '      HLSLPROGRAM',
      '      float4 helper() { return 0; }',
      '      ENDHLSL',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const idx: FileIndex = {
      uri,
      references: [],
      symbols: [
        {
          name: 'helper',
          kind: 'function',
          returnType: 'float4',
          parameters: [],
          location: { uri, range: { start: { line: 7, character: 13 }, end: { line: 7, character: 19 } } },
        } as FunctionSymbolEntry,
      ],
    };
    const { handler } = makeFixture(uri, 'shaderlab', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 2, 'helper'),
    });

    expect(result).toBeNull();
  });

  it('returns null for an unknown identifier with no project or built-in match', async () => {
    const uri = 'file:///t/unknown.hlsl';
    const text = 'float4 main() { return zzzNotAThing(0); }';
    const idx: FileIndex = { uri, references: [], symbols: [] };
    const { handler } = makeFixture(uri, 'hlsl', text, idx);

    const result = await handler({
      textDocument: { uri },
      position: tokenPosition(text, 0, 'zzzNotAThing'),
    });

    expect(result).toBeNull();
  });

  it('passes folderUri through to the formatter so paths become workspace-relative', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usn-issue-18-folderuri-'));
    try {
      const filePath = join(folder, 'sub', 'A.hlsl');
      await mkdir(join(folder, 'sub'), { recursive: true });
      const text = [
        'float4 Helper() { return 0; }',
        'float4 main() { return Helper(); }',
      ].join('\n');
      await writeFile(filePath, text, 'utf8');
      const uri = pathToFileURL(filePath).href;
      const folderUri = pathToFileURL(folder).href;
      const idx = await indexFile(uri, text);
      const { handler } = makeFixture(uri, 'hlsl', text, idx, folderUri);

      const result = await handler({
        textDocument: { uri },
        position: tokenPosition(text, 1, 'Helper'),
      });

      expect(result).not.toBeNull();
      const value = (result?.contents as { value: string }).value;
      // Footer should be relative (sub/A.hlsl), NOT the absolute path.
      expect(value).toContain('`sub/A.hlsl`');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

// Reference the type so the linter does not flag SymbolEntry as unused — it's
// used implicitly through indexFile() but TypeScript needs the import path.
type _Unused = SymbolEntry;
