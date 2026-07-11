import { describe, expect, it, vi } from 'vitest';
import type {
  CompletionItem,
  CompletionParams,
  Connection,
} from 'vscode-languageserver/node';
import { registerCompletionHandler } from '../../src/handlers/completion';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  IndexedWorkspaceRequestRouter,
} from '../../src/workspace/indexedWorkspace';

type CompletionHandler = (params: CompletionParams) => Promise<CompletionItem[] | null>;

const uri = 'file:///project/Assets/Main.hlsl';
const position = { line: 2, character: 12 };

function documentSnapshot(): IndexedDocumentSnapshot {
  return {
    uri,
    languageId: 'hlsl',
    text: 'float4 Main() { He }',
    openId: 17,
    version: 8,
  };
}

function captureHandler(
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): CompletionHandler {
  let handler: CompletionHandler | undefined;
  const connection = {
    onCompletion(candidate: CompletionHandler) {
      handler = candidate;
      return { dispose() {} };
    },
  } as unknown as Connection;
  registerCompletionHandler(connection, documents, manager, suspender);
  if (!handler) throw new Error('completion handler was not registered');
  return handler;
}

describe('registerCompletionHandler', () => {
  it('forwards the captured document snapshot and position to the serving workspace', async () => {
    const document = documentSnapshot();
    const expected: CompletionItem[] = [{ label: 'Helper' }, { label: 'half' }];
    const completionAt = vi.fn(async () => expected);
    const workspace = { completionAt } as unknown as IndexedWorkspace;
    const documents = { snapshot: vi.fn(() => document) };
    const manager = {
      servingWorkspaceFor: vi.fn(() => workspace),
    };
    const handler = captureHandler(documents, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBe(expected);
    expect(documents.snapshot).toHaveBeenCalledOnce();
    expect(documents.snapshot).toHaveBeenCalledWith(uri);
    expect(manager.servingWorkspaceFor).toHaveBeenCalledWith(uri);
    expect(completionAt).toHaveBeenCalledOnce();
    expect(completionAt).toHaveBeenCalledWith({ document, position });
  });

  it('returns null without routing when the document is not open', async () => {
    const manager = { servingWorkspaceFor: vi.fn() };
    const handler = captureHandler({ snapshot: () => undefined }, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
    expect(manager.servingWorkspaceFor).not.toHaveBeenCalled();
  });

  it('does not bypass an existing route that is not serving yet', async () => {
    const workspaceForOrCreateFile = vi.fn();
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      {
        servingWorkspaceFor: () => undefined,
        workspaceFor: () => ({}) as IndexedWorkspace,
        workspaceForOrCreateFile,
      },
    );

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
    expect(workspaceForOrCreateFile).not.toHaveBeenCalled();
  });

  it('waits for RequestSuspender before resolving the workspace query', async () => {
    const expected: CompletionItem[] = [{ label: 'Helper' }];
    const completionAt = vi.fn(async () => expected);
    const workspace = { completionAt } as unknown as IndexedWorkspace;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      { servingWorkspaceFor: () => workspace },
      suspender,
    );

    const result = handler({ textDocument: { uri }, position });
    await Promise.resolve();
    expect(completionAt).not.toHaveBeenCalled();

    suspender.release();
    await expect(result).resolves.toBe(expected);
    expect(completionAt).toHaveBeenCalledOnce();
  });
});
