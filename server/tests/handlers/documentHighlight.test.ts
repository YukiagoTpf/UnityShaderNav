import { describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  DocumentHighlight,
  DocumentHighlightParams,
} from 'vscode-languageserver/node';
import { DocumentHighlightKind } from 'vscode-languageserver/node';
import { registerDocumentHighlightHandler } from '../../src/handlers/documentHighlight';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  IndexedWorkspaceRequestRouter,
} from '../../src/workspace/indexedWorkspace';

type HighlightHandler = (
  params: DocumentHighlightParams,
) => Promise<DocumentHighlight[] | null>;

const uri = 'file:///project/Assets/Main.hlsl';
const position = { line: 4, character: 15 };

function documentSnapshot(): IndexedDocumentSnapshot {
  return {
    uri,
    languageId: 'hlsl',
    text: 'float4 Main() { return Helper(); }',
    openId: 31,
    version: 21,
  };
}

function captureHandler(
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): HighlightHandler {
  let handler: HighlightHandler | undefined;
  const connection = {
    onDocumentHighlight(candidate: HighlightHandler) {
      handler = candidate;
      return { dispose() {} };
    },
  } as unknown as Connection;
  registerDocumentHighlightHandler(connection, documents, manager, suspender);
  if (!handler) throw new Error('document highlight handler was not registered');
  return handler;
}

describe('registerDocumentHighlightHandler', () => {
  it('forwards the captured document snapshot and position to the serving workspace', async () => {
    const document = documentSnapshot();
    const expected: DocumentHighlight[] = [{
      range: {
        start: { line: 1, character: 7 },
        end: { line: 1, character: 13 },
      },
      kind: DocumentHighlightKind.Text,
    }];
    const highlightsAt = vi.fn(async () => expected);
    const workspace = { highlightsAt } as unknown as IndexedWorkspace;
    const documents = { snapshot: vi.fn(() => document) };
    const manager = {
      servingWorkspaceFor: vi.fn(() => workspace),
    };
    const handler = captureHandler(documents, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBe(expected);
    expect(documents.snapshot).toHaveBeenCalledOnce();
    expect(documents.snapshot).toHaveBeenCalledWith(uri);
    expect(manager.servingWorkspaceFor).toHaveBeenCalledWith(uri);
    expect(highlightsAt).toHaveBeenCalledOnce();
    expect(highlightsAt).toHaveBeenCalledWith({ document, position });
  });

  it('returns null without routing when the document is not open', async () => {
    const manager = { servingWorkspaceFor: vi.fn() };
    const handler = captureHandler({ snapshot: () => undefined }, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
    expect(manager.servingWorkspaceFor).not.toHaveBeenCalled();
  });

  it('returns null when the document has no serving workspace', async () => {
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      { servingWorkspaceFor: () => undefined },
    );

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
  });

  it('waits for RequestSuspender before resolving the workspace query', async () => {
    const highlightsAt = vi.fn(async () => null);
    const workspace = { highlightsAt } as unknown as IndexedWorkspace;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      { servingWorkspaceFor: () => workspace },
      suspender,
    );

    const result = handler({ textDocument: { uri }, position });
    await Promise.resolve();
    expect(highlightsAt).not.toHaveBeenCalled();

    suspender.release();
    await expect(result).resolves.toBeNull();
    expect(highlightsAt).toHaveBeenCalledOnce();
  });
});
