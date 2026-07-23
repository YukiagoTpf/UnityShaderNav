import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  type AdapterHandshake,
} from '@unity-shader-nav/shared';
import {
  WorkspaceAdapterCoordinator,
} from '../../src/adapter/workspaceAdapterCoordinator';
import type {
  UnityAdapterClient,
  UnityAdapterClientState,
} from '../../src/adapter/ipc/unityAdapterClient';

class FakeClient {
  readonly listeners = new Set<(state: UnityAdapterClientState) => void>();
  readonly state: UnityAdapterClientState = {
    status: 'unavailable',
    reason: 'no-adapter',
  };
  readonly rpc = undefined;
  starts = 0;
  stops = 0;

  async start(): Promise<void> {
    this.starts++;
  }

  stop(): void {
    this.stops++;
  }

  onDidChangeState(
    listener: (state: UnityAdapterClientState) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
}

function folder(path: string): string {
  return pathToFileURL(path).href;
}

function handshake(projectId: string, instanceId: string): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: Date.now(),
    instanceId,
    capabilities: {
      projectId,
      adapterVersion: '0.1.0',
      unityVersion: '2022.3.62f1',
      supportedFeatures: ['material-context'],
    },
  };
}

describe('WorkspaceAdapterCoordinator', () => {
  it('shares one connection only between folders resolving to the same Unity root', async () => {
    const clients: FakeClient[] = [];
    const coordinator = new WorkspaceAdapterCoordinator({
      createClient() {
        const client = new FakeClient();
        clients.push(client);
        return client as unknown as UnityAdapterClient;
      },
    });
    const firstFolder = folder('/workspace/first');
    const nestedFolder = folder('/workspace/first/Assets/Shaders');
    const otherFolder = folder('/workspace/other');
    coordinator.adapterForFolder(firstFolder);
    coordinator.adapterForFolder(nestedFolder);
    coordinator.adapterForFolder(otherFolder);

    coordinator.reconcile([
      { folderUri: firstFolder, unityRoot: '/projects/game' },
      { folderUri: nestedFolder, unityRoot: '/projects/game' },
      { folderUri: otherFolder, unityRoot: '/projects/tools' },
    ]);
    await Promise.resolve();

    expect(clients).toHaveLength(2);
    expect(clients.map(({ starts }) => starts)).toEqual([1, 1]);
    expect(coordinator.registryForFolder(firstFolder)).toBe(
      coordinator.registryForFolder(nestedFolder),
    );
    expect(coordinator.registryForFolder(firstFolder)).not.toBe(
      coordinator.registryForFolder(otherFolder),
    );

    coordinator.reconcile([
      { folderUri: nestedFolder, unityRoot: '/projects/game' },
      { folderUri: otherFolder, unityRoot: '/projects/tools' },
    ]);
    expect(clients[0].stops).toBe(0);

    coordinator.reconcile([
      { folderUri: otherFolder, unityRoot: '/projects/tools' },
    ]);
    expect(clients[0].stops).toBe(1);
    expect(clients[1].stops).toBe(0);
    coordinator.dispose();
    expect(clients[1].stops).toBe(1);
  });

  it('keeps disconnect and evidence state isolated between project registries', () => {
    const coordinator = new WorkspaceAdapterCoordinator({
      createClient: () => new FakeClient() as unknown as UnityAdapterClient,
    });
    const folderA = folder('/workspace/a');
    const folderB = folder('/workspace/b');
    coordinator.adapterForFolder(folderA);
    coordinator.adapterForFolder(folderB);
    coordinator.reconcile([
      { folderUri: folderA, unityRoot: '/projects/a' },
      { folderUri: folderB, unityRoot: '/projects/b' },
    ]);
    const registryA = coordinator.registryForFolder(folderA)!;
    const registryB = coordinator.registryForFolder(folderB)!;
    registryA.registerHandshake('project-a', handshake('project-a', 'a'));
    registryB.registerHandshake('project-b', handshake('project-b', 'b'));

    registryA.disconnect();

    expect(registryA.status()).toEqual({
      mode: 'standalone',
      reason: 'disconnected',
    });
    expect(registryB.status()).toMatchObject({
      mode: 'adapter',
      capabilities: { projectId: 'project-b' },
    });
  });

  it('does not connect a standalone workspace and reports start failures without throwing', async () => {
    const reportError = vi.fn();
    const failing = new FakeClient();
    failing.start = vi.fn(async () => {
      throw new Error('descriptor read denied');
    });
    const coordinator = new WorkspaceAdapterCoordinator({
      createClient: () => failing as unknown as UnityAdapterClient,
      reportError,
    });
    const standalone = folder('/workspace/standalone');
    const unity = folder('/workspace/unity');
    coordinator.adapterForFolder(standalone);
    coordinator.adapterForFolder(unity);

    coordinator.reconcile([
      { folderUri: standalone, unityRoot: undefined },
      { folderUri: unity, unityRoot: '/projects/unity' },
    ]);
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(coordinator.registryForFolder(standalone)).toBeUndefined();
    expect(coordinator.registryForFolder(unity)).toBeDefined();
    expect(reportError).toHaveBeenCalledWith(
      'Adapter discovery failed for /projects/unity',
      expect.objectContaining({ message: 'descriptor read denied' }),
    );
  });
});
