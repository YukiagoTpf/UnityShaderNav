import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import {
  ADAPTER_INTERFACE_VERSION,
  ADAPTER_STATUS_REQUEST,
  type AdapterCapabilities,
  type AdapterDiagnostic,
  type AdapterHandshake,
  type AdapterStatus,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import { registerAdapterStatusHandler } from '../../src/handlers/adapterStatus';

const CAPABILITIES: AdapterCapabilities = {
  unityVersion: '2022.3.62f1',
  projectId: 'project-a',
  adapterVersion: '0.1.0',
  supportedFeatures: ['adapter-status'],
};

function handshake(
  issuedAt: number,
  overrides: Partial<AdapterHandshake> = {},
): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt,
    instanceId: 'instance-a',
    capabilities: CAPABILITIES,
    ...overrides,
  };
}

type RequestHandler = (
  params?: unknown,
  cancellation?: undefined,
) => AdapterStatus;

function fakeConnection(): {
  connection: Connection;
  getHandler(): RequestHandler;
} {
  let handler: RequestHandler | undefined;
  const connection = {
    onRequest(method: string, registered: RequestHandler) {
      expect(method).toBe(ADAPTER_STATUS_REQUEST);
      handler = registered;
      return { dispose() {} };
    },
  } as unknown as Connection;
  return {
    connection,
    getHandler() {
      if (!handler) throw new Error('handler was not registered');
      return handler;
    },
  };
}

describe('AdapterRegistry', () => {
  it('observes connect, disconnect, and reconnect status transitions', () => {
    const now = 1_000_000;
    const registry = new AdapterRegistry({ now: () => now });
    const statuses: AdapterStatus[] = [];
    registry.onDidChangeStatus((status) => { statuses.push(status); });

    registry.registerHandshake('project-a', handshake(now));
    registry.disconnect();
    registry.registerHandshake('project-a', {
      ...handshake(now),
      instanceId: 'instance-b',
    });

    expect(statuses).toEqual([
      { mode: 'adapter', capabilities: CAPABILITIES },
      { mode: 'standalone', reason: 'disconnected' },
      { mode: 'adapter', capabilities: CAPABILITIES },
    ]);
  });

  it('observes a connected handshake becoming stale', () => {
    let now = 1_000_000;
    const registry = new AdapterRegistry({
      now: () => now,
      handshakeMaxAgeMs: 1_000,
    });
    registry.registerHandshake('project-a', handshake(now));
    const statuses: AdapterStatus[] = [];
    registry.onDidChangeStatus((status) => { statuses.push(status); });

    now += 1_001;

    expect(registry.status()).toEqual({ mode: 'standalone', reason: 'stale' });
    expect(statuses).toEqual([{ mode: 'standalone', reason: 'stale' }]);
  });

  it('returns current-asset ShaderMessages with their Adapter provenance', async () => {
    const now = 1_000_000;
    const uri = 'file:///project/Assets/Current.shader';
    const result: AdapterDiagnostic[] = [{
      shaderMessage: {
        message: "undeclared identifier 'missing'",
        messageDetails: 'at frag',
        file: 'Assets/Current.shader',
        line: 12,
        severity: 'error',
        platform: 'd3d11',
      },
      provenance: {
        capability: 'shader-messages',
        adapterVersion: '0.1.0',
        unityVersion: '2022.3.62f1',
        projectId: 'project-a',
        instanceId: 'instance-a',
        collectedAt: now,
        sourceRevision: {
          uri,
          assetGuid: 'asset-guid',
          contentHash: 'current-hash',
        },
      },
    }];
    const source = {
      getShaderMessages: async (documentUri: string) => {
        expect(documentUri).toBe(uri);
        return result;
      },
    };
    const registry = new AdapterRegistry({ now: () => now, messageSource: source });
    registry.registerHandshake('project-a', {
      ...handshake(now),
      instanceId: 'instance-a',
      capabilities: {
        ...CAPABILITIES,
        supportedFeatures: ['adapter-status', 'shader-messages'],
      },
    });

    await expect(registry.shaderMessagesFor(uri, 'current-hash')).resolves.toEqual(result);
  });

  it('round-trips current capabilities through the LSP request', () => {
    const now = 1_000_000;
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(now));
    const { connection, getHandler } = fakeConnection();
    registerAdapterStatusHandler(connection, registry);

    expect(getHandler()()).toEqual({
      mode: 'adapter',
      capabilities: CAPABILITIES,
    });
  });

  it('reports Standalone mode when no Adapter is available', () => {
    const registry = new AdapterRegistry();
    const { connection, getHandler } = fakeConnection();
    registerAdapterStatusHandler(connection, registry);

    expect(getHandler()()).toEqual({
      mode: 'standalone',
      reason: 'no-adapter',
    });
  });

  it('rejects stale handshake evidence', () => {
    let now = 1_000_000;
    const registry = new AdapterRegistry({
      now: () => now,
      handshakeMaxAgeMs: 1_000,
    });
    registry.registerHandshake('project-a', handshake(now));

    now += 1_001;

    expect(registry.status()).toEqual({
      mode: 'standalone',
      reason: 'stale',
    });
  });

  it('rejects evidence from a foreign project identity', () => {
    const now = 1_000_000;
    const registry = new AdapterRegistry({ now: () => now });

    expect(registry.registerHandshake('project-b', handshake(now))).toEqual({
      mode: 'standalone',
      reason: 'foreign-project',
    });
  });

  it('rejects disconnected and version-incompatible evidence observably', () => {
    const now = 1_000_000;
    const registry = new AdapterRegistry({ now: () => now });
    expect(registry.registerHandshake('project-a', handshake(now, {
      interfaceVersion: ADAPTER_INTERFACE_VERSION + 1,
    }))).toEqual({
      mode: 'standalone',
      reason: 'version-incompatible',
    });

    registry.disconnect();

    expect(registry.status()).toEqual({
      mode: 'standalone',
      reason: 'disconnected',
    });
  });
});
