import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import {
  ADAPTER_INTERFACE_VERSION,
  ADAPTER_STATUS_REQUEST,
  type AdapterCapabilities,
  type AdapterDiagnostic,
  type AdapterHandshake,
  type AdapterStatus,
  type CompileProfile,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import { registerAdapterStatusHandler } from '../../src/handlers/adapterStatus';

const CAPABILITIES: AdapterCapabilities = {
  unityVersion: '2022.3.62f1',
  projectId: 'project-a',
  adapterVersion: '0.1.0',
  supportedFeatures: ['adapter-status'],
};

const D3D_PROFILE: CompileProfile = {
  name: 'd3d11',
  platform: 'StandaloneWindows64',
  graphicsApi: 'Direct3D11',
  capability: 'compile-profile/d3d11',
};

const VULKAN_PROFILE: CompileProfile = {
  name: 'vulkan',
  platform: 'StandaloneLinux64',
  graphicsApi: 'Vulkan',
  capability: 'compile-profile/vulkan',
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
  it('discovers compile profiles from each connected Unity Adapter capability set', async () => {
    const now = 1_000_000;
    let reportedProfiles: readonly CompileProfile[] = [
      D3D_PROFILE,
      VULKAN_PROFILE,
    ];
    const registry = new AdapterRegistry({
      now: () => now,
      profileSource: {
        getCompileProfiles: async () => reportedProfiles,
      },
    });

    registry.registerHandshake('project-a', {
      ...handshake(now),
      capabilities: {
        ...CAPABILITIES,
        unityVersion: '2022.3.62f1',
        supportedFeatures: [D3D_PROFILE.capability],
      },
    });
    await expect(registry.compileProfiles()).resolves.toEqual({
      status: 'available',
      profiles: [D3D_PROFILE],
    });

    reportedProfiles = [VULKAN_PROFILE];
    registry.registerHandshake('project-a', {
      ...handshake(now),
      instanceId: 'instance-unity-6',
      capabilities: {
        ...CAPABILITIES,
        unityVersion: '6000.0.31f1',
        supportedFeatures: [VULKAN_PROFILE.capability],
      },
    });
    await expect(registry.compileProfiles()).resolves.toEqual({
      status: 'available',
      profiles: [VULKAN_PROFILE],
    });
  });

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

  it('runs one selected profile and reports its bounded compiler outcome', async () => {
    let now = 1_000_000;
    const uri = 'file:///project/Assets/Current.shader';
    const result: AdapterDiagnostic[] = [
      {
        shaderMessage: {
          message: 'implicit truncation',
          file: 'Assets/Current.shader',
          line: 8,
          severity: 'warning',
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
      },
      {
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
      },
    ];
    const source = {
      getShaderMessages: async (
        documentUri: string,
        selectedProfile: CompileProfile,
      ) => {
        expect(documentUri).toBe(uri);
        expect(selectedProfile).toEqual(D3D_PROFILE);
        now += 37;
        return result;
      },
    };
    const registry = new AdapterRegistry({
      now: () => now,
      messageSource: source,
      profileSource: {
        getCompileProfiles: async () => [D3D_PROFILE],
      },
    });
    registry.registerHandshake('project-a', {
      ...handshake(now),
      instanceId: 'instance-a',
      capabilities: {
        ...CAPABILITIES,
        supportedFeatures: [
          'adapter-status',
          'shader-messages',
          D3D_PROFILE.capability,
        ],
      },
    });

    await expect(registry.shaderMessagesFor(
      uri,
      'current-hash',
      D3D_PROFILE,
    )).resolves.toEqual({
      status: 'completed',
      profile: D3D_PROFILE,
      durationMs: 37,
      success: false,
      warningCount: 1,
      errorCount: 1,
      diagnostics: result.map((diagnostic) => ({
        ...diagnostic,
        profile: D3D_PROFILE,
      })),
    });
  });

  it('reports a requested profile that the connected Adapter does not support', async () => {
    const now = 1_000_000;
    const registry = new AdapterRegistry({
      now: () => now,
      profileSource: {
        getCompileProfiles: async () => [D3D_PROFILE],
      },
      messageSource: {
        getShaderMessages: async () => {
          throw new Error('an unsupported profile must not reach the compiler');
        },
      },
    });
    registry.registerHandshake('project-a', {
      ...handshake(now),
      capabilities: {
        ...CAPABILITIES,
        supportedFeatures: [
          'shader-messages',
          D3D_PROFILE.capability,
        ],
      },
    });

    await expect(registry.shaderMessagesFor(
      'file:///project/Assets/Current.shader',
      'current-hash',
      VULKAN_PROFILE,
    )).resolves.toEqual({
      status: 'profile-not-supported',
      requestedProfile: VULKAN_PROFILE,
      availableProfiles: [D3D_PROFILE],
    });
  });

  it('reports why a selected profile cannot run without an Adapter', async () => {
    const registry = new AdapterRegistry();

    await expect(registry.shaderMessagesFor(
      'file:///project/Assets/Current.shader',
      'current-hash',
      D3D_PROFILE,
    )).resolves.toEqual({
      status: 'adapter-unavailable',
      requestedProfile: D3D_PROFILE,
      reason: 'no-adapter',
    });
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
