import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import {
  VISUAL_LAB_CAPTURE_REQUEST,
  VISUAL_LAB_SELECT_TARGET_REQUEST,
  VISUAL_LAB_STATE_REQUEST,
  type VisualLabSessionState,
} from '@unity-shader-nav/shared';
import type { VisualLabService } from '../../src/adapter/visualLabService';
import { registerVisualLabHandlers } from '../../src/handlers/visualLab';

type RequestHandler = (params: never) => unknown;

function availableState(label: string): VisualLabSessionState {
  return {
    status: 'unavailable',
    reason: 'invalid-target',
    before: { status: 'empty', slot: 'before' },
    after: { status: 'empty', slot: 'after' },
    pinnedTarget: {
      selectionId: label,
      contextRevision: 'context-a',
      material: {
        name: label,
        path: `Assets/${label}.mat`,
        revision: {
          uri: `file:///project/Assets/${label}.mat`,
          assetGuid: `${label}-material`,
          contentHash: 'a'.repeat(64),
        },
      },
      source: {
        name: `${label} Shader`,
        path: `Assets/${label}.shader`,
        revision: {
          uri: `file:///project/Assets/${label}.shader`,
          assetGuid: `${label}-shader`,
          contentHash: 'b'.repeat(64),
        },
      },
      shaderContext: {
        contextId: 'context-a',
        shaderName: label,
        subShaderIndex: 0,
        passIndex: 0,
        stage: 'fragment',
        entryPoint: 'frag',
        keywords: { material: [], global: [], engineAdded: [] },
      },
      pipeline: { id: 'built-in', kind: 'built-in', name: 'Built-in' },
      profile: {
        id: 'profile',
        buildTarget: 'StandaloneOSX',
        graphicsApi: 'Metal',
        qualityLevel: 0,
        renderTarget: { width: 1, height: 1, format: 'RGBA32' },
      },
      colorSpace: 'linear',
      adapter: {
        projectId: 'project',
        instanceId: label,
        adapterVersion: '1',
        unityVersion: '2022.3',
      },
      renderInputId: 'input',
    },
  };
}

function service(label: string): VisualLabService {
  const state = availableState(label);
  return {
    state: vi.fn(() => state),
    selectCurrentTarget: vi.fn(async () => state),
    capture: vi.fn(async () => state),
  } as unknown as VisualLabService;
}

describe('registerVisualLabHandlers', () => {
  it('routes every request by document URI and keeps state pulls side-effect free', async () => {
    const handlers = new Map<string, RequestHandler>();
    const connection = {
      onRequest(method: string, handler: RequestHandler) {
        handlers.set(method, handler);
      },
    } as unknown as Connection;
    const first = service('first');
    const second = service('second');
    registerVisualLabHandlers(connection, (uri) => (
      uri.includes('/first/') ? first
        : uri.includes('/second/') ? second
          : undefined
    ));

    const firstParams = {
      textDocument: { uri: 'file:///first/Capture.shader' },
    };
    const secondParams = {
      textDocument: { uri: 'file:///second/Capture.shader' },
    };
    const stateHandler = handlers.get(VISUAL_LAB_STATE_REQUEST)!;

    expect(stateHandler(firstParams as never)).toMatchObject({
      pinnedTarget: { selectionId: 'first' },
    });
    expect(stateHandler(secondParams as never)).toMatchObject({
      pinnedTarget: { selectionId: 'second' },
    });
    expect(vi.mocked(first.selectCurrentTarget)).not.toHaveBeenCalled();
    expect(vi.mocked(second.selectCurrentTarget)).not.toHaveBeenCalled();

    await handlers.get(VISUAL_LAB_SELECT_TARGET_REQUEST)!(secondParams as never);
    await handlers.get(VISUAL_LAB_CAPTURE_REQUEST)!({
      ...firstParams,
      slot: 'before',
    } as never);

    expect(vi.mocked(second.selectCurrentTarget)).toHaveBeenCalledWith(
      secondParams.textDocument.uri,
    );
    expect(vi.mocked(first.capture)).toHaveBeenCalledWith('before');
  });

  it('returns an explicit no-Adapter state when no workspace owns the URI', async () => {
    const handlers = new Map<string, RequestHandler>();
    const connection = {
      onRequest(method: string, handler: RequestHandler) {
        handlers.set(method, handler);
      },
    } as unknown as Connection;
    registerVisualLabHandlers(connection, () => undefined);
    const params = {
      textDocument: { uri: 'untitled:orphan.shader' },
    };

    expect(handlers.get(VISUAL_LAB_STATE_REQUEST)!(params as never)).toEqual({
      status: 'unavailable',
      reason: 'no-adapter',
      before: { status: 'empty', slot: 'before' },
      after: { status: 'empty', slot: 'after' },
    });
    await expect(
      handlers.get(VISUAL_LAB_SELECT_TARGET_REQUEST)!(params as never),
    ).resolves.toMatchObject({ reason: 'no-adapter' });
  });
});
