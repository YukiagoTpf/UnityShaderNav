import { describe, expect, it, vi } from 'vitest';
import {
  VISUAL_LAB_ADAPTER_DESCRIBE_METHOD,
  VISUAL_LAB_ADAPTER_FEATURE,
  VISUAL_LAB_ADAPTER_RENDER_METHOD,
  type AdapterStatus,
} from '@unity-shader-nav/shared';
import { VisualLabRpcSource } from '../../../src/adapter/ipc/visualLabRpcSource';
import type { AdapterRpcConnection } from '../../../src/adapter/ipc/rpcConnection';
import type {
  UnityAdapterClientState,
} from '../../../src/adapter/ipc/unityAdapterClient';

class FakeConnection {
  readonly request = vi.fn(async (
    _capability: string,
    _method: string,
    params: unknown,
  ) => params);
  private readonly eventListeners = new Set<(event: {
    readonly capability: string;
    readonly event: string;
    readonly payload?: unknown;
  }) => void>();

  onDidReceiveEvent(listener: (event: {
    readonly capability: string;
    readonly event: string;
    readonly payload?: unknown;
  }) => void): { dispose(): void } {
    this.eventListeners.add(listener);
    return { dispose: () => { this.eventListeners.delete(listener); } };
  }

  emit(reason: string): void {
    for (const listener of this.eventListeners) {
      listener({
        capability: VISUAL_LAB_ADAPTER_FEATURE,
        event: 'target-changed',
        payload: { reason },
      });
    }
  }
}

class FakeCoordinator {
  connection: FakeConnection | undefined;
  state: UnityAdapterClientState | undefined;
  private readonly listeners = new Set<(status: AdapterStatus) => void>();

  rpcForFolder(): AdapterRpcConnection | undefined {
    return this.connection as unknown as AdapterRpcConnection | undefined;
  }

  stateForFolder(): UnityAdapterClientState | undefined {
    return this.state;
  }

  onDidChangeStatus(
    listener: (status: AdapterStatus) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  publish(): void {
    for (const listener of this.listeners) {
      listener({ mode: 'standalone', reason: 'disconnected' });
    }
  }
}

function connected(instanceId: string): UnityAdapterClientState {
  return {
    status: 'connected',
    projectHash: 'a'.repeat(64),
    instanceId,
    adapterVersion: '0.1.0',
    unityVersion: '2022.3.62f1',
    capabilities: [{ name: VISUAL_LAB_ADAPTER_FEATURE, version: 1 }],
  };
}

describe('VisualLabRpcSource', () => {
  it('uses the current authenticated stream for describe and render requests', async () => {
    const coordinator = new FakeCoordinator();
    const first = new FakeConnection();
    coordinator.connection = first;
    coordinator.state = connected('editor-a');
    const source = new VisualLabRpcSource(
      coordinator as never,
      'file:///workspace',
    );

    await expect(source.describePreviewTarget({ selection: {} as never }))
      .resolves.toEqual({ selection: {} });
    await expect(source.renderPreview({
      slot: 'before',
      requestGeneration: 1,
      target: {} as never,
    })).resolves.toMatchObject({ slot: 'before' });

    expect(first.request.mock.calls.map(([capability, method]) => (
      [capability, method]
    ))).toEqual([
      [VISUAL_LAB_ADAPTER_FEATURE, VISUAL_LAB_ADAPTER_DESCRIBE_METHOD],
      [VISUAL_LAB_ADAPTER_FEATURE, VISUAL_LAB_ADAPTER_RENDER_METHOD],
    ]);

    const second = new FakeConnection();
    coordinator.connection = second;
    coordinator.state = connected('editor-b');
    coordinator.publish();
    await source.describePreviewTarget({ selection: {} as never });
    expect(second.request).toHaveBeenCalledTimes(1);
  });

  it('turns stream and Adapter target events into immediate stale reasons', () => {
    const coordinator = new FakeCoordinator();
    const first = new FakeConnection();
    coordinator.connection = first;
    coordinator.state = connected('editor-a');
    const source = new VisualLabRpcSource(
      coordinator as never,
      'file:///workspace',
    );
    const reasons: string[] = [];
    const subscription = source.onDidInvalidate((reason) => {
      reasons.push(reason);
    });

    first.emit('profile-changed');
    coordinator.connection = undefined;
    coordinator.state = {
      status: 'unavailable',
      reason: 'disconnected',
    };
    coordinator.publish();
    const second = new FakeConnection();
    coordinator.connection = second;
    coordinator.state = connected('editor-b');
    coordinator.publish();
    second.emit('unknown-reason');

    expect(reasons).toEqual([
      'profile-changed',
      'adapter-disconnected',
      'render-input-changed',
    ]);
    subscription.dispose();
  });

  it('rejects requests when disconnected or already cancelled', async () => {
    const coordinator = new FakeCoordinator();
    const source = new VisualLabRpcSource(
      coordinator as never,
      'file:///workspace',
    );
    await expect(source.describePreviewTarget({ selection: {} as never }))
      .rejects.toThrow('disconnected');

    const controller = new AbortController();
    controller.abort(new Error('superseded'));
    await expect(source.renderPreview({
      slot: 'after',
      requestGeneration: 2,
      target: {} as never,
    }, controller.signal)).rejects.toThrow('superseded');
  });
});
