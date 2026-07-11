import { describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  SignatureHelp,
  SignatureHelpParams,
} from 'vscode-languageserver/node';
import { registerSignatureHelpHandler } from '../../src/handlers/signatureHelp';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';
import type {
  IndexedDocumentRegistry,
  IndexedDocumentSnapshot,
  IndexedWorkspace,
  IndexedWorkspaceRequestRouter,
} from '../../src/workspace/indexedWorkspace';

type SignatureHelpHandler = (params: SignatureHelpParams) => Promise<SignatureHelp | null>;

const uri = 'file:///project/Assets/Main.hlsl';
const position = { line: 5, character: 21 };

function documentSnapshot(): IndexedDocumentSnapshot {
  return {
    uri,
    languageId: 'hlsl',
    text: 'float4 Main() { return Lighting(normalWS, }',
    openId: 23,
    version: 13,
  };
}

function captureHandler(
  documents: Pick<IndexedDocumentRegistry, 'snapshot'>,
  manager: IndexedWorkspaceRequestRouter,
  suspender?: Pick<RequestSuspender, 'run'>,
): SignatureHelpHandler {
  let handler: SignatureHelpHandler | undefined;
  const connection = {
    onSignatureHelp(candidate: SignatureHelpHandler) {
      handler = candidate;
      return { dispose() {} };
    },
  } as unknown as Connection;
  registerSignatureHelpHandler(connection, documents, manager, suspender);
  if (!handler) throw new Error('signature help handler was not registered');
  return handler;
}

describe('registerSignatureHelpHandler', () => {
  it('forwards the captured document snapshot and position to the serving workspace', async () => {
    const document = documentSnapshot();
    const expected: SignatureHelp = {
      signatures: [{ label: 'float4 Lighting(float3 normalWS, half roughness)' }],
      activeSignature: 0,
      activeParameter: 1,
    };
    const signatureHelpAt = vi.fn(async () => expected);
    const workspace = { signatureHelpAt } as unknown as IndexedWorkspace;
    const documents = { snapshot: vi.fn(() => document) };
    const manager = {
      servingWorkspaceFor: vi.fn(() => workspace),
    };
    const handler = captureHandler(documents, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBe(expected);
    expect(documents.snapshot).toHaveBeenCalledOnce();
    expect(documents.snapshot).toHaveBeenCalledWith(uri);
    expect(manager.servingWorkspaceFor).toHaveBeenCalledWith(uri);
    expect(signatureHelpAt).toHaveBeenCalledOnce();
    expect(signatureHelpAt).toHaveBeenCalledWith({ document, position });
  });

  it('returns null without routing when the document is not open', async () => {
    const manager = { servingWorkspaceFor: vi.fn() };
    const handler = captureHandler({ snapshot: () => undefined }, manager);

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
    expect(manager.servingWorkspaceFor).not.toHaveBeenCalled();
  });

  it('returns null when no serving or creatable route exists', async () => {
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      {
        servingWorkspaceFor: () => undefined,
        workspaceFor: () => undefined,
        workspaceForOrCreateFile: async () => undefined,
      },
    );

    await expect(handler({ textDocument: { uri }, position })).resolves.toBeNull();
  });

  it('waits for RequestSuspender before resolving the workspace query', async () => {
    const signatureHelpAt = vi.fn(async () => null);
    const workspace = { signatureHelpAt } as unknown as IndexedWorkspace;
    const suspender = new RequestSuspender({ timeoutMs: 1000 });
    suspender.suspend();
    const handler = captureHandler(
      { snapshot: () => documentSnapshot() },
      { servingWorkspaceFor: () => workspace },
      suspender,
    );

    const result = handler({ textDocument: { uri }, position });
    await Promise.resolve();
    expect(signatureHelpAt).not.toHaveBeenCalled();

    suspender.release();
    await expect(result).resolves.toBeNull();
    expect(signatureHelpAt).toHaveBeenCalledOnce();
  });
});
