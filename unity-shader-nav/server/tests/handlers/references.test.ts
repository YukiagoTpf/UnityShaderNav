import { describe, expect, it } from 'vitest';
import type { Connection, Location, ReferenceParams } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex } from '@unity-shader-nav/shared';
import { GlobalReferenceIndex, GlobalSymbolIndex } from '../../src/index';
import { registerReferencesHandler } from '../../src/handlers/references';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';

function captureReferencesHandler(): {
  connection: Connection;
  handler: () => ((params: ReferenceParams) => Promise<Location[] | null>);
} {
  let handler: ((params: ReferenceParams) => Promise<Location[] | null>) | undefined;
  const connection = {
    onReferences(fn: (params: ReferenceParams) => Promise<Location[] | null>) {
      handler = fn;
      return { dispose() {} };
    },
  } as unknown as Connection;

  return {
    connection,
    handler: () => {
      if (!handler) throw new Error('references handler was not registered');
      return handler;
    },
  };
}

const defRange = {
  start: { line: 0, character: 7 },
  end: { line: 0, character: 13 },
};
const userRefRange = {
  start: { line: 1, character: 23 },
  end: { line: 1, character: 29 },
};
const packageRefRange = {
  start: { line: 2, character: 23 },
  end: { line: 2, character: 29 },
};

describe('registerReferencesHandler', () => {
  it('returns declaration and non-package references for the word under the cursor', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Use.hlsl';
    const packageUri = 'file:///project/Packages/com.example.render/Core.hlsl';
    const doc = TextDocument.create(
      uri,
      'hlsl',
      1,
      'float4 helper() { return 0; }\nfloat4 main() { return helper(); }',
    );
    const index: FileIndex = {
      uri,
      symbols: [{
        name: 'helper',
        kind: 'function',
        location: { uri, range: defRange },
      }],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri, range: userRefRange },
      }],
    };
    const packageIndex: FileIndex = {
      uri: packageUri,
      symbols: [],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri: packageUri, range: packageRefRange },
      }],
    };
    const workspace = {
      global: new GlobalSymbolIndex(),
      globalRefs: new GlobalReferenceIndex(),
      isInPackages(requestedUri: string) {
        return requestedUri === packageUri;
      },
    };
    workspace.global.upsert(index);
    workspace.globalRefs.upsert(index);
    workspace.globalRefs.upsert(packageIndex);
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

    registerReferencesHandler(connection, documents, manager, () => false);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 1, character: 25 },
      context: { includeDeclaration: true },
    });

    expect(result).toEqual([
      { uri, range: defRange },
      { uri, range: userRefRange },
    ]);
  });

  it('includes package references when the setting is enabled', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Use.hlsl';
    const packageUri = 'file:///project/Packages/com.example.render/Core.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 main() { return helper(); }');
    const workspace = {
      global: new GlobalSymbolIndex(),
      globalRefs: new GlobalReferenceIndex(),
      isInPackages(requestedUri: string) {
        return requestedUri === packageUri;
      },
    };
    workspace.globalRefs.upsert({
      uri: packageUri,
      symbols: [],
      references: [{
        name: 'helper',
        context: 'call',
        location: { uri: packageUri, range: packageRefRange },
      }],
    });
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return workspace;
      },
    } as never;

    registerReferencesHandler(connection, documents, manager, () => true);

    const result = await handler()({
      textDocument: { uri },
      position: { line: 0, character: 25 },
      context: { includeDeclaration: false },
    });

    expect(result).toEqual([{ uri: packageUri, range: packageRefRange }]);
  });

  it('waits for RequestSuspender release before resolving references', async () => {
    const { connection, handler } = captureReferencesHandler();
    const uri = 'file:///project/Assets/Use.hlsl';
    const doc = TextDocument.create(uri, 'hlsl', 1, 'float4 main() { return 0; }');
    const documents = {
      get(requestedUri: string) {
        return requestedUri === uri ? doc : undefined;
      },
    } as never;
    const manager = {
      async workspaceForOrCreateFile() {
        return {
          global: new GlobalSymbolIndex(),
          globalRefs: new GlobalReferenceIndex(),
          isInPackages: () => false,
        };
      },
    } as never;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();

    registerReferencesHandler(connection, documents, manager, () => false, suspender);

    const promise = handler()({
      textDocument: { uri },
      position: { line: 0, character: 7 },
      context: { includeDeclaration: false },
    });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(settled).toBe(false);
    suspender.release();
    await expect(promise).resolves.toEqual([]);
  });
});
