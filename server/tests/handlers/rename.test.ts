import { describe, expect, it } from 'vitest';
import {
  LSPErrorCodes,
  type Connection,
  type PrepareRenameParams,
  type Range,
  type RenameParams,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { registerRenameHandler } from '../../src/handlers/rename';
import { indexFile } from '../../src/parser/hlsl/fileIndexer';
import {
  createDocumentRegistry,
  createIndexedWorkspaceFixture,
} from '../helpers/indexedWorkspaceFixture';

type PrepareResult = Range | { range: Range; placeholder: string } | null;

function captureHandlers() {
  let prepare: ((params: PrepareRenameParams) => Promise<PrepareResult>) | undefined;
  let rename: ((params: RenameParams) => Promise<WorkspaceEdit | null>) | undefined;
  const connection = {
    onPrepareRename(handler: typeof prepare) {
      prepare = handler;
      return { dispose() {} };
    },
    onRenameRequest(handler: typeof rename) {
      rename = handler;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    prepare: () => {
      if (!prepare) throw new Error('Prepare Rename handler was not registered');
      return prepare;
    },
    rename: () => {
      if (!rename) throw new Error('Rename handler was not registered');
      return rename;
    },
  };
}

describe('registerRenameHandler', () => {
  it('adapts Prepare Rename and Rename through Indexed Workspace behavior', async () => {
    const uri = 'file:///project/Rename.hlsl';
    const text = [
      'float4 Helper() { return 1; }',
      'float4 Main() { return Helper(); }',
    ].join('\n');
    const document = TextDocument.create(uri, 'hlsl', 1, text);
    const documents = createDocumentRegistry(document);
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const handlers = captureHandlers();
    registerRenameHandler(handlers.connection, documents, {
      servingWorkspaceFor: () => workspace,
    });
    const position = { line: 1, character: 26 };

    await expect(handlers.prepare()({
      textDocument: { uri },
      position,
    })).resolves.toMatchObject({ placeholder: 'Helper' });
    await expect(handlers.rename()({
      textDocument: { uri },
      position,
      newName: 'RenamedHelper',
    })).resolves.toEqual({
      changes: {
        [uri]: [
          { range: expect.any(Object), newText: 'RenamedHelper' },
          { range: expect.any(Object), newText: 'RenamedHelper' },
        ],
      },
    });
  });

  it('returns an actionable LSP error for ambiguous Rename', async () => {
    const uri = 'file:///project/Ambiguous.hlsl';
    const text = [
      'float Helper(float value) { return value; }',
      'float2 Helper(float2 value) { return value; }',
      'float Main() { return Helper(1); }',
    ].join('\n');
    const document = TextDocument.create(uri, 'hlsl', 1, text);
    const documents = createDocumentRegistry(document);
    const workspace = createIndexedWorkspaceFixture([await indexFile(uri, text)]);
    const handlers = captureHandlers();
    registerRenameHandler(handlers.connection, documents, {
      servingWorkspaceFor: () => workspace,
    });

    await expect(handlers.prepare()({
      textDocument: { uri },
      position: { line: 2, character: 24 },
    })).rejects.toMatchObject({
      code: LSPErrorCodes.RequestFailed,
      message: expect.stringContaining('ambiguous'),
    });
  });

  it('returns null when the document is not open', async () => {
    const handlers = captureHandlers();
    registerRenameHandler(
      handlers.connection,
      { snapshot: () => undefined },
      { servingWorkspaceFor: () => undefined },
    );

    await expect(handlers.prepare()({
      textDocument: { uri: 'file:///missing.hlsl' },
      position: { line: 0, character: 0 },
    })).resolves.toBeNull();
  });
});
