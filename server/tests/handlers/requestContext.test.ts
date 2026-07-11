import { describe, expect, it, vi } from 'vitest';
import type { FileIndex } from '@unity-shader-nav/shared';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { TextDocuments } from 'vscode-languageserver/node';
import { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../../src/index';
import type { WorkspaceManager } from '../../src/workspace';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { resolveRequestContext } from '../../src/handlers/requestContext';

const URI = 'file:///proj/Main.shader';

function fileIndex(uri: string): FileIndex {
  return { uri, symbols: [], references: [] };
}

function fakeDocuments(docs: Record<string, TextDocument>): TextDocuments<TextDocument> {
  return {
    get(uri: string) {
      return docs[uri];
    },
  } as unknown as TextDocuments<TextDocument>;
}

interface FakeWorkspaceOptions {
  store?: IndexStore;
  reindex?: (uri: string, text: string) => Promise<void> | void;
  updateDocument?: (document: IndexedDocumentSnapshot) => Promise<boolean>;
  includeCtx?: { unityProjectRoot: string | undefined; includeDirectories: string[] };
}

function fakeManager(
  uri: string,
  workspace: unknown,
  document?: IndexedDocumentSnapshot,
): WorkspaceManager {
  return {
    servingWorkspaceFor(requestedUri: string) {
      return requestedUri === uri ? workspace : undefined;
    },
    openDocumentSnapshot(requestedUri: string) {
      return requestedUri === uri ? document : undefined;
    },
  } as unknown as WorkspaceManager;
}

function fullWorkspace(options: FakeWorkspaceOptions = {}) {
  const store = options.store ?? new IndexStore();
  return {
    ...(options.updateDocument ? { updateDocument: options.updateDocument } : {}),
    index: {
      store,
      global: new GlobalSymbolIndex(),
      globalRefs: new GlobalReferenceIndex(),
      ...(options.reindex ? { reindex: options.reindex } : {}),
    },
    packages: {
      includeCtx: options.includeCtx ?? { unityProjectRoot: undefined, includeDirectories: [] },
    },
  };
}

describe('resolveRequestContext', () => {
  it('returns null when the document is missing and requireDocument defaults to true', async () => {
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({}),
      fakeManager(URI, fullWorkspace()),
    );
    expect(ctx).toBeNull();
  });

  it('returns null when the workspace cannot be resolved', async () => {
    const doc = TextDocument.create(URI, 'shaderlab', 1, '');
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({ [URI]: doc }),
      fakeManager('file:///other', fullWorkspace()),
    );
    expect(ctx).toBeNull();
  });

  it('never enters the background bootstrap path for an indexing root', async () => {
    const legacyBootstrap = vi.fn(() => new Promise<never>(() => {}));
    const manager = {
      servingWorkspaceFor: () => undefined,
      workspaceForOrCreateFile: legacyBootstrap,
    } as unknown as WorkspaceManager;

    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({
        [URI]: TextDocument.create(URI, 'shaderlab', 1, ''),
      }),
      manager,
    );

    expect(ctx).toBeNull();
    expect(legacyBootstrap).not.toHaveBeenCalled();
  });

  it('resolves a context even without a document when requireDocument is false', async () => {
    const store = new IndexStore();
    store.set(URI, fileIndex(URI));
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({}),
      fakeManager(URI, fullWorkspace({ store })),
      { requireDocument: false },
    );
    expect(ctx).not.toBeNull();
    expect(await ctx!.index()).toMatchObject({ uri: URI });
  });

  it('index() returns the stored index without reindexing when present', async () => {
    const store = new IndexStore();
    store.set(URI, fileIndex(URI));
    let reindexCalls = 0;
    const doc = TextDocument.create(URI, 'shaderlab', 1, 'live');
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({ [URI]: doc }),
      fakeManager(URI, fullWorkspace({
        store,
        reindex: () => {
          reindexCalls += 1;
        },
      })),
    );
    expect(await ctx!.index()).toMatchObject({ uri: URI });
    expect(reindexCalls).toBe(0);
  });

  it('index() joins the registry snapshot through Workspace behavior on a live miss', async () => {
    const store = new IndexStore();
    const doc = TextDocument.create(URI, 'shaderlab', 1, 'live text');
    const snapshot: IndexedDocumentSnapshot = {
      uri: URI,
      languageId: 'shaderlab',
      text: 'live text',
      openId: 4,
      version: 2,
    };
    let updateCalls = 0;
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({ [URI]: doc }),
      fakeManager(URI, fullWorkspace({
        store,
        updateDocument: async (document) => {
          updateCalls++;
          expect(document).toBe(snapshot);
          store.set(document.uri, fileIndex(document.uri));
          return true;
        },
      }), snapshot),
    );
    const first = await ctx!.index();
    const second = await ctx!.index();
    expect(first).toMatchObject({ uri: URI });
    expect(second).toBe(first);
    expect(updateCalls).toBe(1);
  });

  it('index() never invokes a legacy reindex implementation on a miss', async () => {
    const store = new IndexStore();
    let reindexCalls = 0;
    const doc = TextDocument.create(URI, 'shaderlab', 1, 'live');
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({ [URI]: doc }),
      fakeManager(URI, fullWorkspace({
        store,
        reindex: () => {
          reindexCalls += 1; // never populates the store
        },
      })),
    );
    expect(await ctx!.index()).toBeUndefined();
    expect(await ctx!.index()).toBeUndefined();
    expect(reindexCalls).toBe(0);
  });

  it('index() does not throw when reindex is absent and the store misses', async () => {
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({ [URI]: TextDocument.create(URI, 'shaderlab', 1, '') }),
      fakeManager(URI, fullWorkspace()), // no reindex
    );
    expect(await ctx!.index()).toBeUndefined();
  });

  it('visibleUriKeys() shares a single memoized walk across calls', async () => {
    const store = new IndexStore();
    store.set(URI, fileIndex(URI));
    const ctx = await resolveRequestContext(
      URI,
      fakeDocuments({ [URI]: TextDocument.create(URI, 'shaderlab', 1, '') }),
      fakeManager(URI, fullWorkspace({ store })),
    );
    const first = ctx!.visibleUriKeys();
    const second = ctx!.visibleUriKeys();
    expect(second).toBe(first);
    expect([...(await first)]).toContain(URI);
  });

  it('does not dereference workspace fields a handler never reads', async () => {
    // Mirrors the documentSymbol fixture: a workspace with only `index.store`,
    // no `packages` / `global` / `globalRefs`, and an empty `documents`.
    const store = new IndexStore();
    store.set(URI, fileIndex(URI));
    const workspace = { index: { store } };
    const ctx = await resolveRequestContext(
      URI,
      {} as unknown as TextDocuments<TextDocument>,
      fakeManager(URI, workspace),
      { requireDocument: false },
    );
    expect(ctx).not.toBeNull();
    // Reading only what documentSymbol reads must not touch packages/globalRefs.
    expect(await ctx!.index()).toMatchObject({ uri: URI });
    expect(ctx!.store).toBe(store);
  });
});
