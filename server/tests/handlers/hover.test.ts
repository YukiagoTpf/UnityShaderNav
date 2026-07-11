import { describe, expect, it, vi } from 'vitest';
import type { Connection, Hover, HoverParams } from 'vscode-languageserver/node';
import { registerHoverHandler } from '../../src/handlers/hover';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  IndexedWorkspaceRequestRouter,
} from '../../src/workspace/indexedWorkspace';

type HoverHandler = (params: HoverParams) => Promise<Hover | null>;

const uri = 'file:///project/Assets/Main.hlsl';
const position = { line: 3, character: 7 };

function documentSnapshot(): IndexedDocumentSnapshot {
  return {
    uri,
    languageId: 'hlsl',
    text: 'float4 Main() { return Helper(); }',
    openId: 11,
    version: 4,
  };
}

function captureHandler(
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): HoverHandler {
  let handler: HoverHandler | undefined;
  const connection = {
    onHover(candidate: HoverHandler) {
      handler = candidate;
      return { dispose() {} };
    },
  } as unknown as Connection;
  registerHoverHandler(connection, documents, manager, suspender);
  if (!handler) throw new Error('hover handler was not registered');
  return handler;
}

describe('registerHoverHandler', () => {
  it('forwards the captured document snapshot and position to the serving workspace', async () => {
    const document = documentSnapshot();
    const expected: Hover = { contents: 'project hover' };
    const hoverAt = vi.fn(async () => expected);
    const workspace = { hoverAt } as unknown as IndexedWorkspace;
    const documents = { snapshot: vi.fn(() => document) };
    const manager = {
      servingWorkspaceFor: vi.fn(() => workspace),
    };
    const handler = captureHandler(documents, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBe(expected);
    expect(documents.snapshot).toHaveBeenCalledOnce();
    expect(documents.snapshot).toHaveBeenCalledWith(uri);
    expect(manager.servingWorkspaceFor).toHaveBeenCalledWith(uri);
    expect(hoverAt).toHaveBeenCalledOnce();
    expect(hoverAt).toHaveBeenCalledWith({ document, position });
  });

  it('returns null without routing when the document is not open', async () => {
    const manager = { servingWorkspaceFor: vi.fn() };
    const handler = captureHandler({ snapshot: () => undefined }, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
    expect(manager.servingWorkspaceFor).not.toHaveBeenCalled();
  });

  it('returns null when the current route is not serving', async () => {
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      { servingWorkspaceFor: () => undefined },
    );

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
  });

  it('lazily recreates a missing route for the same open session', async () => {
    const document = documentSnapshot();
    const expected: Hover = { contents: 'lazy hover' };
    const hoverAt = vi.fn(async () => expected);
    const workspace = { hoverAt } as unknown as IndexedWorkspace;
    const documents = { snapshot: vi.fn(() => document) };
    const workspaceForOrCreateFile = vi.fn(async (
      requestedUri: string,
      shouldCreate?: () => boolean,
    ) => {
      expect(requestedUri).toBe(uri);
      expect(shouldCreate?.()).toBe(true);
      return workspace;
    });
    const handler = captureHandler(documents, {
      servingWorkspaceFor: () => undefined,
      workspaceFor: () => undefined,
      workspaceForOrCreateFile,
    });

    await expect(handler({ textDocument: { uri }, position })).resolves.toBe(expected);
    expect(workspaceForOrCreateFile).toHaveBeenCalledOnce();
    expect(hoverAt).toHaveBeenCalledWith({ document, position });
  });

  it('waits for RequestSuspender before resolving the workspace query', async () => {
    const hoverAt = vi.fn(async () => null);
    const workspace = { hoverAt } as unknown as IndexedWorkspace;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      { servingWorkspaceFor: () => workspace },
      suspender,
    );

    const result = handler({ textDocument: { uri }, position });
    await Promise.resolve();
    expect(hoverAt).not.toHaveBeenCalled();

    suspender.release();
    await expect(result).resolves.toBeNull();
    expect(hoverAt).toHaveBeenCalledOnce();
  });
});
