import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import {
  ADAPTER_INTERFACE_VERSION,
  ADAPTER_STATUS_REQUEST,
  type AdapterCapabilities,
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
