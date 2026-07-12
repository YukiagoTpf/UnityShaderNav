import { describe, expect, it, vi } from 'vitest';
import type {
  ColorPresentationParams,
  Connection,
  DocumentColorParams,
  DocumentFormattingParams,
} from 'vscode-languageserver/node';
import { registerColorHandlers } from '../../src/handlers/colors';
import { registerDocumentFormattingHandler } from '../../src/handlers/formatting';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';

const document: IndexedDocumentSnapshot = {
  uri: 'file:///project/Assets/Authoring.shader',
  languageId: 'shaderlab',
  text: 'Shader "X" {}',
  openId: 7,
  version: 3,
};

describe('authoring handlers', () => {
  it('routes color and presentation requests through the exact document workspace', async () => {
    let colorHandler: ((params: DocumentColorParams) => Promise<unknown>) | undefined;
    let presentationHandler: ((params: ColorPresentationParams) => Promise<unknown>) | undefined;
    const connection = {
      onDocumentColor(handler: typeof colorHandler) { colorHandler = handler; },
      onColorPresentation(handler: typeof presentationHandler) { presentationHandler = handler; },
    } as unknown as Connection;
    const range = {
      start: { line: 1, character: 10 },
      end: { line: 1, character: 22 },
    };
    const color = { red: 1, green: 0, blue: 0, alpha: 1 };
    const documentColors = vi.fn(async () => [{ range, color }]);
    const colorPresentations = vi.fn(async () => [{ label: '(1, 0, 0, 1)' }]);
    const workspace = { documentColors, colorPresentations } as unknown as IndexedWorkspace;
    registerColorHandlers(
      connection,
      { snapshot: () => document },
      { servingWorkspaceFor: () => workspace },
    );

    await expect(colorHandler!({ textDocument: { uri: document.uri } })).resolves.toEqual([{
      range,
      color,
    }]);
    await expect(presentationHandler!({
      textDocument: { uri: document.uri },
      range,
      color,
    })).resolves.toEqual([{ label: '(1, 0, 0, 1)' }]);
    expect(documentColors).toHaveBeenCalledWith({ uri: document.uri, document });
    expect(colorPresentations).toHaveBeenCalledWith({ document, range, color });
  });

  it('forwards formatting options and stays neutral without an open document', async () => {
    let handler: ((params: DocumentFormattingParams) => Promise<unknown>) | undefined;
    const connection = {
      onDocumentFormatting(candidate: typeof handler) { handler = candidate; },
    } as unknown as Connection;
    const formatDocument = vi.fn(async () => []);
    const workspace = { formatDocument } as unknown as IndexedWorkspace;
    const documents = { snapshot: vi.fn(() => document as IndexedDocumentSnapshot | undefined) };
    registerDocumentFormattingHandler(
      connection,
      documents,
      { servingWorkspaceFor: () => workspace },
    );
    const params = {
      textDocument: { uri: document.uri },
      options: { tabSize: 2, insertSpaces: true },
    };

    await expect(handler!(params)).resolves.toEqual([]);
    expect(formatDocument).toHaveBeenCalledWith({ document, options: params.options });
    documents.snapshot.mockReturnValue(undefined);
    await expect(handler!(params)).resolves.toBeNull();
  });
});
