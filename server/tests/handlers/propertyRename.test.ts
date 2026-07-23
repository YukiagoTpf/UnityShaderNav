import { describe, expect, it, vi } from 'vitest';
import {
  PROPERTY_RENAME_BEGIN_REQUEST,
  PROPERTY_RENAME_FINISH_REQUEST,
  PROPERTY_RENAME_PREVIEW_REQUEST,
  type PropertyRenameBeginParams,
  type PropertyRenameFinishParams,
  type PropertyRenameParams,
} from '@unity-shader-nav/shared';
import type { Connection } from 'vscode-languageserver/node';
import { registerPropertyRenameHandler } from '../../src/handlers/propertyRename';
import type {
  IndexedDocumentSnapshot,
  IndexedWorkspace,
} from '../../src/workspace/indexedWorkspace';

describe('safe Property Rename protocol handlers', () => {
  it('routes preview, begin, and idempotent finish through one serving Workspace', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const connection = {
      onRequest(method: string, handler: (...args: any[]) => unknown) {
        handlers.set(method, handler);
        return { dispose() {} };
      },
    } as unknown as Connection;
    const document: IndexedDocumentSnapshot = {
      uri: 'file:///project/Assets/Lit.shader',
      languageId: 'shaderlab',
      text: 'Shader "Lit" { Properties { _Tint ("Tint", Color) = (1,1,1,1) } }',
      openId: 1,
      version: 1,
    };
    const previewPropertyRenameAt = vi.fn(async () => ({
      status: 'ready' as const,
      preview: {
        previewId: 'preview-1',
        oldName: '_Tint',
        newName: '_Color',
        groups: [],
        blockers: [],
        manualFollowUps: [],
        canApply: true,
      },
    }));
    const beginPropertyRenameAt = vi.fn(async () => ({
      status: 'ready' as const,
      transactionId: 'transaction-1',
      edits: [],
    }));
    const finishPropertyRename = vi.fn(async () => ({
      status: 'committed' as const,
    }));
    const workspace = {
      previewPropertyRenameAt,
      beginPropertyRenameAt,
      finishPropertyRename,
    } as unknown as IndexedWorkspace;
    registerPropertyRenameHandler(
      connection,
      { snapshot: (uri) => uri === document.uri ? document : undefined },
      { servingWorkspaceFor: () => workspace },
    );

    const params: PropertyRenameParams = {
      textDocument: { uri: document.uri },
      position: { line: 0, character: 30 },
      newName: '_Color',
    };
    await expect(
      handlers.get(PROPERTY_RENAME_PREVIEW_REQUEST)!(params),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(previewPropertyRenameAt).toHaveBeenCalledWith(expect.objectContaining({
      document,
      newName: '_Color',
    }));

    const beginParams: PropertyRenameBeginParams = {
      ...params,
      previewId: 'preview-1',
    };
    await expect(
      handlers.get(PROPERTY_RENAME_BEGIN_REQUEST)!(beginParams),
    ).resolves.toMatchObject({
      status: 'ready',
      transactionId: 'transaction-1',
    });
    expect(beginPropertyRenameAt).toHaveBeenCalledWith(expect.objectContaining({
      previewId: 'preview-1',
    }));

    const finishParams: PropertyRenameFinishParams = {
      textDocument: { uri: document.uri },
      transactionId: 'transaction-1',
      sourceApplied: true,
    };
    await expect(
      handlers.get(PROPERTY_RENAME_FINISH_REQUEST)!(finishParams),
    ).resolves.toEqual({ status: 'committed' });
    expect(finishPropertyRename).toHaveBeenCalledWith('transaction-1', true);
  });
});
