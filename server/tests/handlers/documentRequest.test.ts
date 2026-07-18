import { describe, expect, it, vi } from 'vitest';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';
import { createDocumentRequestHandler } from '../../src/handlers/documentRequest';

const document: IndexedDocumentSnapshot = {
  uri: 'file:///Main.hlsl',
  languageId: 'hlsl',
  text: 'float4 Main();',
  openId: 3,
  version: 7,
};

const workspace = {} as IndexedWorkspace;

describe('createDocumentRequestHandler', () => {
  it('captures an open snapshot, routes it, and resolves the request', async () => {
    const documents = { snapshot: vi.fn(() => document) };
    const manager = { servingWorkspaceFor: vi.fn(() => workspace) };
    const resolve = vi.fn(async (_params: { textDocument: { uri: string } }, context) => (
      `${context.document.version}:${context.workspace === workspace}`
    ));
    const handler = createDocumentRequestHandler(documents, manager, undefined, {
      uri: (params: { textDocument: { uri: string } }) => params.textDocument.uri,
      neutral: () => 'neutral',
      resolve,
    });

    await expect(handler({ textDocument: { uri: document.uri } }))
      .resolves.toBe('7:true');
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('returns the endpoint neutral without routing when no open snapshot exists', async () => {
    const manager = { servingWorkspaceFor: vi.fn(() => workspace) };
    const handler = createDocumentRequestHandler(
      { snapshot: () => undefined },
      manager,
      undefined,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => [] as string[],
        resolve: async () => ['unexpected'],
      },
    );

    await expect(handler({ uri: document.uri })).resolves.toEqual([]);
    expect(manager.servingWorkspaceFor).not.toHaveBeenCalled();
  });

  it('can route a closed document to an existing serving workspace', async () => {
    const manager = { servingWorkspaceFor: vi.fn(() => workspace) };
    const handler = createDocumentRequestHandler(
      { snapshot: () => undefined },
      manager,
      undefined,
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => 'neutral',
        allowClosedDocument: true,
        resolve: async (_params, context) => (
          context.document === undefined && context.workspace === workspace
            ? 'closed'
            : 'unexpected'
        ),
      },
    );

    await expect(handler({ uri: document.uri })).resolves.toBe('closed');
    expect(manager.servingWorkspaceFor).toHaveBeenCalledWith(document.uri);
  });

  it('maps a suspended timeout to a fresh endpoint neutral', async () => {
    let neutralCount = 0;
    const handler = createDocumentRequestHandler(
      { snapshot: () => document },
      { servingWorkspaceFor: () => workspace },
      { run: async () => null },
      {
        uri: (params: { uri: string }) => params.uri,
        neutral: () => ({ request: ++neutralCount }),
        resolve: async () => ({ request: 99 }),
      },
    );

    await expect(handler({ uri: document.uri })).resolves.toEqual({ request: 1 });
  });
});
