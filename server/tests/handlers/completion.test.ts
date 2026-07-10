import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CompletionItem, CompletionParams, Connection } from 'vscode-languageserver/node';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerCompletionHandler } from '../../src/handlers/completion';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

function captureCompletion(
  uri: string,
  languageId: string,
  text: string,
  workspace: unknown,
) {
  let handler: ((params: CompletionParams) => Promise<CompletionItem[] | null>) | undefined;
  const connection = {
    onCompletion(fn: (params: CompletionParams) => Promise<CompletionItem[] | null>) {
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;
  const doc = TextDocument.create(uri, languageId, 1, text);
  const documents = {
    get(requestedUri: string) {
      return requestedUri === uri ? doc : undefined;
    },
  } as never;
  const manager = {
    async workspaceForOrCreateFile(requestedUri: string) {
      return requestedUri === uri ? workspace : undefined;
    },
  } as never;
  registerCompletionHandler(connection, documents, manager);
  if (!handler) throw new Error('completion handler was not registered');
  return handler;
}

function completionWorkspace(indexes: FileIndex[], root?: string) {
  const store = new IndexStore();
  const global = new GlobalSymbolIndex();
  for (const index of indexes) {
    store.set(index.uri, index);
    global.upsert(index);
  }
  return {
    packages: { includeCtx: { unityProjectRoot: root, includeDirectories: [] } },
    index: { store, global },
  };
}

function itemNames(items: CompletionItem[] | null): string[] {
  return items?.map((item) => item.label) ?? [];
}

describe('registerCompletionHandler', () => {
  it('returns built-in completions in HLSL expression context', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = 'float4 main() { return nor; }';
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'hlsl', text, completionWorkspace([index]));

    const result = await handler({
      textDocument: { uri },
      position: { line: 0, character: text.indexOf('nor') + 'nor'.length },
    });

    expect(result?.find((item) => item.label === 'normalize')).toMatchObject({
      kind: CompletionItemKind.Function,
      detail: 'T normalize(T x)',
    });
  });

  it('returns built-in ShaderLab completions in outer ShaderLab code', async () => {
    const uri = 'file:///t/main.shader';
    const text = 'Shader "T/Test" { SubShader { Pass { Bl } } }';
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'shaderlab', text, completionWorkspace([index]));

    const result = await handler({
      textDocument: { uri },
      position: { line: 0, character: text.indexOf('Bl') + 'Bl'.length },
    });

    expect(itemNames(result)).toContain('Blend');
    expect(itemNames(result)).not.toContain('normalize');
  });

  it('prefers project completions over duplicate built-ins', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 normalize(float4 v) { return v; }',
      'float4 main(float4 v) { return nor; }',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'hlsl', text, completionWorkspace([index]));

    const result = await handler({
      textDocument: { uri },
      position: { line: 1, character: 34 },
    });
    const matches = result?.filter((item) => item.label === 'normalize') ?? [];

    expect(matches).toHaveLength(1);
    expect(matches[0]?.detail).toBe('float4 normalize(float4 v)');
  });

  it('preserves overload-like project function completions while filtering built-in duplicates', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 Lighting(float4 v) { return v; }',
      'half4 Lighting(half4 v) { return v; }',
      'float4 main(float4 v) { return Lig; }',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'hlsl', text, completionWorkspace([index]));

    const result = await handler({
      textDocument: { uri },
      position: { line: 2, character: 34 },
    });
    const matches = result?.filter((item) => item.label === 'Lighting') ?? [];

    expect(matches.map((item) => item.detail)).toEqual([
      'float4 Lighting(float4 v)',
      'half4 Lighting(half4 v)',
    ]);
  });

  it('keeps project and built-in expression completions after ternary colons', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 helper(float4 v) { return v; }',
      'float4 main(bool useA, float4 a) {',
      '  return useA ? a : hel;',
      '  return useA ? a : nor;',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'hlsl', text, completionWorkspace([index]));

    const projectResult = await handler({
      textDocument: { uri },
      position: { line: 2, character: 23 },
    });
    const builtinResult = await handler({
      textDocument: { uri },
      position: { line: 3, character: 23 },
    });

    expect(itemNames(projectResult)).toContain('helper');
    expect(itemNames(projectResult)).not.toContain('SV_Target');
    expect(itemNames(builtinResult)).toContain('normalize');
    expect(itemNames(builtinResult)).not.toContain('SV_Target');
  });

  it('returns same-file function completions filtered by prefix', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 helper(float4 v) { return v; }',
      'float4 main() { return hel; }',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'hlsl', text, completionWorkspace([index]));

    const result = await handler({
      textDocument: { uri },
      position: { line: 1, character: 28 },
    });

    expect(result?.find((item) => item.label === 'helper')).toMatchObject({
      kind: CompletionItemKind.Function,
      detail: 'float4 helper(float4 v)',
    });
  });

  it('reindexes the open document on store miss', async () => {
    const uri = 'file:///t/live.hlsl';
    const text = 'float4 helper(float4 v) { return v; }\nfloat4 main() { return hel; }';
    const store = new IndexStore();
    const global = new GlobalSymbolIndex();
    const workspace = {
      packages: { includeCtx: { unityProjectRoot: undefined, includeDirectories: [] } },
      index: {
        store,
        global,
        async reindex(requestedUri: string, requestedText: string) {
          const index = await indexFile(requestedUri, requestedText);
          store.set(index.uri, index);
          global.upsert(index);
        },
      },
    };
    const handler = captureCompletion(uri, 'hlsl', text, workspace);

    const result = await handler({
      textDocument: { uri },
      position: { line: 1, character: 28 },
    });

    expect(itemNames(result)).toContain('helper');
  });

  it('returns include-visible function completions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-completion-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.hlsl');
      const sharedPath = join(assets, 'Shared.hlsl');
      const otherPath = join(assets, 'Other.hlsl');
      const mainText = '#include "Shared.hlsl"\nfloat4 main() { return Incl; }';
      const sharedText = 'float4 Included() { return 1; }';
      const otherText = 'float4 Hidden() { return 2; }';
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(sharedPath, sharedText, 'utf8');
      await writeFile(otherPath, otherText, 'utf8');
      const indexes = await Promise.all([
        indexFile(pathToFileURL(mainPath).href, mainText),
        indexFile(pathToFileURL(sharedPath).href, sharedText),
        indexFile(pathToFileURL(otherPath).href, otherText),
      ]);
      const handler = captureCompletion(indexes[0].uri, 'hlsl', mainText, completionWorkspace(indexes, root));

      const result = await handler({
        textDocument: { uri: indexes[0].uri },
        position: { line: 1, character: 28 },
      });

      expect(itemNames(result)).toContain('Included');
      expect(itemNames(result)).not.toContain('Hidden');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects comments and strings', async () => {
    const uri = 'file:///t/main.shader';
    const text = [
      'Shader "T/Test" {',
      '  Properties { helper ("helper", Float) = 0 }',
      '  SubShader { Pass { HLSLPROGRAM',
      '    float4 helper(float4 v) { return v; }',
      '    // helper',
      '    float4 main() { const char* s = "helper"; return 0; }',
      '  ENDHLSL } }',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'shaderlab', text, completionWorkspace([index]));

    await expect(handler({ textDocument: { uri }, position: { line: 4, character: 8 } }))
      .resolves.toEqual([]);
    await expect(handler({ textDocument: { uri }, position: { line: 5, character: 40 } }))
      .resolves.toEqual([]);
  });

  it('returns member completions for receiver shapes supported by chain lookup', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'struct Light { float3 color; };',
      'struct Brdf { float roughness; };',
      'struct Surface { Brdf brdfData; float3 positionWS; };',
      'float4 frag(Surface surface, Light lights[4], int i) {',
      '  surface.',
      '  lights[i].',
      '  surface.brdfData.',
      '  return 0;',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureCompletion(uri, 'hlsl', text, completionWorkspace([index]));

    expect(itemNames(await handler({ textDocument: { uri }, position: { line: 4, character: 10 } })))
      .toEqual(expect.arrayContaining(['positionWS', 'brdfData']));
    expect(itemNames(await handler({ textDocument: { uri }, position: { line: 5, character: 12 } })))
      .toContain('color');
    expect(itemNames(await handler({ textDocument: { uri }, position: { line: 6, character: 20 } })))
      .toContain('roughness');
    expect(itemNames(await handler({ textDocument: { uri }, position: { line: 4, character: 10 } })))
      .not.toContain('normalize');
  });

  it('waits on RequestSuspender', async () => {
    let handler: ((params: CompletionParams) => Promise<CompletionItem[] | null>) | undefined;
    const uri = 'file:///t/main.hlsl';
    const text = 'float4 main() { return 0; }';
    const connection = {
      onCompletion(fn: (params: CompletionParams) => Promise<CompletionItem[] | null>) {
        handler = fn;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const documents = {
      get() {
        return TextDocument.create(uri, 'hlsl', 1, text);
      },
    } as never;
    const workspace = completionWorkspace([{ uri, references: [], symbols: [] }]);
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();

    registerCompletionHandler(connection, documents, manager, suspender);
    if (!handler) throw new Error('completion handler was not registered');
    const promise = handler({ textDocument: { uri }, position: { line: 0, character: 17 } });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(settled).toBe(false);
    suspender.release();
    // The suspended request must eventually resolve; the actual completion
    // payload depends on the curated builtin vocabulary, which expands over
    // time, so only assert that the handler ran to completion.
    await expect(promise).resolves.toEqual(expect.any(Array));
  });
});
