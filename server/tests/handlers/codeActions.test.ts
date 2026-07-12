import { describe, expect, it, vi } from 'vitest';
import type {
  CodeAction,
  CodeActionParams,
  Connection,
} from 'vscode-languageserver/node';
import { registerCodeActionHandler } from '../../src/handlers/codeActions';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';

type Handler = (params: CodeActionParams) => Promise<CodeAction[]>;

const uri = 'file:///project/Assets/Material.shader';
const document: IndexedDocumentSnapshot = {
  uri,
  languageId: 'shaderlab',
  text: 'Shader "Material" {}',
  openId: 3,
  version: 7,
};
const range = {
  start: { line: 2, character: 4 },
  end: { line: 2, character: 9 },
};
const params: CodeActionParams = {
  textDocument: { uri },
  range,
  context: { diagnostics: [] },
};

function capture(
  snapshot: () => IndexedDocumentSnapshot | undefined,
  servingWorkspaceFor: () => IndexedWorkspace | undefined,
): Handler {
  let handler: Handler | undefined;
  const connection = {
    onCodeAction(candidate: Handler) {
      handler = candidate;
      return { dispose() {} };
    },
  } as unknown as Connection;
  registerCodeActionHandler(
    connection,
    { snapshot },
    { servingWorkspaceFor },
  );
  if (!handler) throw new Error('code action handler was not registered');
  return handler;
}

describe('registerCodeActionHandler', () => {
  it('forwards the exact document attempt, range, and diagnostics context', async () => {
    const expected: CodeAction[] = [{ title: 'Fix', kind: 'quickfix' }];
    const codeActionsAt = vi.fn(async () => expected);
    const handler = capture(
      () => document,
      () => ({ codeActionsAt } as unknown as IndexedWorkspace),
    );

    await expect(handler(params)).resolves.toBe(expected);
    expect(codeActionsAt).toHaveBeenCalledWith({
      document,
      range,
      context: params.context,
    });
  });

  it('returns an empty list without an open document', async () => {
    const servingWorkspaceFor = vi.fn();
    const handler = capture(() => undefined, servingWorkspaceFor);

    await expect(handler(params)).resolves.toEqual([]);
    expect(servingWorkspaceFor).not.toHaveBeenCalled();
  });

  it('returns an empty list without a serving workspace', async () => {
    const handler = capture(() => document, () => undefined);
    await expect(handler(params)).resolves.toEqual([]);
  });
});
