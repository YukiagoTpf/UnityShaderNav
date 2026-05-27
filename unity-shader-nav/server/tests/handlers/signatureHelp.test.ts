import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, SignatureHelp, SignatureHelpParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalSymbolIndex, IndexStore } from '../../src/index';
import { registerSignatureHelpHandler } from '../../src/handlers/signatureHelp';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';

function signatureWorkspace(indexes: FileIndex[], root?: string) {
  const store = new IndexStore();
  const global = new GlobalSymbolIndex();
  for (const index of indexes) {
    store.set(index.uri, index);
    global.upsert(index);
  }
  return {
    includeCtx: { unityProjectRoot: root, includeDirectories: [] },
    store,
    global,
  };
}

function captureSignatureHelp(
  uri: string,
  languageId: string,
  text: string,
  workspace: unknown,
  suspender?: Pick<RequestSuspender, 'run'>,
) {
  let handler: ((params: SignatureHelpParams) => Promise<SignatureHelp | null>) | undefined;
  const connection = {
    onSignatureHelp(fn: (params: SignatureHelpParams) => Promise<SignatureHelp | null>) {
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
  registerSignatureHelpHandler(connection, documents, manager, suspender);
  if (!handler) throw new Error('signature help handler was not registered');
  return handler;
}

describe('registerSignatureHelpHandler', () => {
  it('returns same-file function signature help', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 Lighting(float3 normalWS, half roughness) { return 1; }',
      'float4 main(float3 n) { return Lighting(',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureSignatureHelp(uri, 'hlsl', text, signatureWorkspace([index]));

    const result = await handler({ textDocument: { uri }, position: { line: 1, character: 40 } });

    expect(result).toMatchObject({
      activeSignature: 0,
      activeParameter: 0,
      signatures: [{ label: 'float4 Lighting(float3 normalWS, half roughness)' }],
    });
  });

  it('sets active parameter after the first comma', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 Lighting(float3 normalWS, half roughness) { return 1; }',
      'float4 main(float3 n) { return Lighting(n, ',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureSignatureHelp(uri, 'hlsl', text, signatureWorkspace([index]));

    const result = await handler({ textDocument: { uri }, position: { line: 1, character: 43 } });

    expect(result?.activeParameter).toBe(1);
  });

  it('returns include-visible and ambiguous signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-signature-'));
    try {
      const assets = join(root, 'Assets');
      await mkdir(assets, { recursive: true });
      const mainPath = join(assets, 'Main.hlsl');
      const sharedPath = join(assets, 'Shared.hlsl');
      const otherPath = join(assets, 'Other.hlsl');
      const mainText = '#include "Shared.hlsl"\nfloat4 main(float3 n) { return Lighting(';
      const sharedText = [
        'float4 Lighting(float3 normalWS) { return 1; }',
        'float4 Lighting(half3 normalWS) { return 1; }',
      ].join('\n');
      const otherText = 'float4 Lighting(float4 hidden) { return 1; }';
      await writeFile(mainPath, mainText, 'utf8');
      await writeFile(sharedPath, sharedText, 'utf8');
      await writeFile(otherPath, otherText, 'utf8');
      const indexes = await Promise.all([
        indexFile(pathToFileURL(mainPath).href, mainText),
        indexFile(pathToFileURL(sharedPath).href, sharedText),
        indexFile(pathToFileURL(otherPath).href, otherText),
      ]);
      const handler = captureSignatureHelp(indexes[0].uri, 'hlsl', mainText, signatureWorkspace(indexes, root));

      const result = await handler({ textDocument: { uri: indexes[0].uri }, position: { line: 1, character: 40 } });

      expect(result?.signatures.map((signature) => signature.label)).toEqual([
        'float4 Lighting(float3 normalWS)',
        'float4 Lighting(half3 normalWS)',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clamps active parameter to the active signature arity', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 Lighting(float3 n) { return 1; }',
      'float4 Lighting(float3 n, half r, half m) { return 1; }',
      'float4 main() { return Lighting(a, b, ',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureSignatureHelp(uri, 'hlsl', text, signatureWorkspace([index]));

    const result = await handler({ textDocument: { uri }, position: { line: 2, character: 38 } });

    expect(result?.activeSignature).toBe(0);
    expect(result?.signatures[0]?.parameters).toHaveLength(1);
    expect(result?.activeParameter).toBe(0);
  });

  it('returns null inside function declarations', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = 'float4 Lighting(float3 n, half r) { return 1; }';
    const index = await indexFile(uri, text);
    const handler = captureSignatureHelp(uri, 'hlsl', text, signatureWorkspace([index]));

    await expect(handler({ textDocument: { uri }, position: { line: 0, character: 30 } })).resolves.toBeNull();
  });

  it('returns null for unknown callees, non-function symbols, comments, and strings', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = [
      'float4 Lighting;',
      'float4 main() {',
      '  return Missing(',
      '  return Lighting(',
      '  // Lighting(',
      '  const char* s = "Lighting(";',
      '}',
    ].join('\n');
    const index = await indexFile(uri, text);
    const handler = captureSignatureHelp(uri, 'hlsl', text, signatureWorkspace([index]));

    await expect(handler({ textDocument: { uri }, position: { line: 2, character: 17 } })).resolves.toBeNull();
    await expect(handler({ textDocument: { uri }, position: { line: 3, character: 18 } })).resolves.toBeNull();
    await expect(handler({ textDocument: { uri }, position: { line: 4, character: 14 } })).resolves.toBeNull();
    await expect(handler({ textDocument: { uri }, position: { line: 5, character: 28 } })).resolves.toBeNull();
  });

  it('reindexes the open document on store miss', async () => {
    const uri = 'file:///t/live.hlsl';
    const text = 'float4 Lighting(float3 n) { return 1; }\nfloat4 main() { return Lighting(';
    const store = new IndexStore();
    const global = new GlobalSymbolIndex();
    const workspace = {
      includeCtx: { unityProjectRoot: undefined, includeDirectories: [] },
      store,
      global,
      async reindex(requestedUri: string, requestedText: string) {
        const index = await indexFile(requestedUri, requestedText);
        store.set(index.uri, index);
        global.upsert(index);
      },
    };
    const handler = captureSignatureHelp(uri, 'hlsl', text, workspace);

    const result = await handler({ textDocument: { uri }, position: { line: 1, character: 32 } });

    expect(result?.signatures[0]?.label).toBe('float4 Lighting(float3 n)');
  });

  it('waits on RequestSuspender', async () => {
    const uri = 'file:///t/main.hlsl';
    const text = 'float4 main() { return 0; }';
    const workspace = signatureWorkspace([{ uri, references: [], symbols: [] }]);
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();
    const handler = captureSignatureHelp(uri, 'hlsl', text, workspace, suspender);

    const promise = handler({ textDocument: { uri }, position: { line: 0, character: 17 } });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(settled).toBe(false);
    suspender.release();
    await expect(promise).resolves.toBeNull();
  });
});
