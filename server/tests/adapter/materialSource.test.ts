import { describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  MATERIAL_PROPERTY_RENAME_ADAPTER_FEATURE,
  MATERIAL_USAGES_ADAPTER_FEATURE,
  type AdapterHandshake,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type { MaterialSource } from '../../src/adapter/materialSource';

const now = 1_000_000;

function handshake(
  projectId = 'project-a',
  instanceId = 'editor-1',
): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId,
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId,
      adapterVersion: '0.2.0',
      supportedFeatures: [MATERIAL_USAGES_ADAPTER_FEATURE],
    },
  };
}

describe('Adapter Material source trust boundary', () => {
  it('returns current project Material facts with stable provenance', async () => {
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader(shader) {
        expect(shader).toEqual({
          name: 'Tests/Lit',
          path: 'Assets/Shaders/Lit.shader',
        });
        return {
          assetScope: 'complete',
          revision: 'materials-7',
          collectedAt: now,
          materials: [{
            guid: '11111111111111111111111111111111',
            path: 'Assets/Materials/Ship.mat',
            properties: [{
              name: '_Tint',
              type: 'vector',
              serializedValue: [1, 0.5, 0.25, 1],
            }],
          }],
        };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), source);

    await expect(registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    })).resolves.toEqual({
      availability: 'available',
      assetScope: 'complete',
      runtimeMaterials: 'unknown',
      revision: 'materials-7',
      materials: [{
        guid: '11111111111111111111111111111111',
        path: 'Assets/Materials/Ship.mat',
        properties: [{
          name: '_Tint',
          type: 'vector',
          serializedValue: [1, 0.5, 0.25, 1],
        }],
        provenance: {
          capability: MATERIAL_USAGES_ADAPTER_FEATURE,
          projectId: 'project-a',
          instanceId: 'editor-1',
          adapterVersion: '0.2.0',
          unityVersion: '2022.3.62f1',
          collectedAt: now,
          sourceRevision: 'materials-7',
        },
      }],
    });
  });

  it('reports unavailable Adapter and asset scopes as unknown, never zero usage', async () => {
    const registry = new AdapterRegistry({ now: () => now });
    await expect(registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    })).resolves.toEqual({
      availability: 'unknown',
      assetScope: 'unknown',
      runtimeMaterials: 'unknown',
      reason: 'no-adapter',
    });

    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'unknown',
          reason: 'asset-scope-unavailable',
        };
      },
    };
    registry.registerHandshake('project-a', handshake(), source);

    await expect(registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    })).resolves.toEqual({
      availability: 'unknown',
      assetScope: 'unknown',
      runtimeMaterials: 'unknown',
      reason: 'asset-scope-unavailable',
    });
  });

  it('invalidates disconnected facts and accepts only the reconnected instance', async () => {
    const first: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: 'materials-old',
          collectedAt: now,
          materials: [{
            guid: '11111111111111111111111111111111',
            path: 'Assets/Materials/Old.mat',
            properties: [],
          }],
        };
      },
    };
    const second: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-2' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: 'materials-new',
          collectedAt: now,
          materials: [{
            guid: '22222222222222222222222222222222',
            path: 'Assets/Materials/New.mat',
            properties: [],
          }],
        };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake('project-a', 'editor-1'), first);
    registry.disconnect();

    await expect(registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    })).resolves.toMatchObject({
      availability: 'unknown',
      reason: 'disconnected',
    });

    registry.registerHandshake(
      'project-a',
      handshake('project-a', 'editor-2'),
      second,
    );
    const reconnected = await registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    });

    expect(reconnected).toMatchObject({
      availability: 'available',
      revision: 'materials-new',
      materials: [{
        guid: '22222222222222222222222222222222',
        provenance: { instanceId: 'editor-2' },
      }],
    });
  });

  it('rejects stale handshakes and foreign source identities before reading facts', async () => {
    let currentTime = now;
    let reads = 0;
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        reads++;
        return {
          assetScope: 'complete',
          revision: 'materials-1',
          collectedAt: now,
          materials: [],
        };
      },
    };
    const registry = new AdapterRegistry({
      now: () => currentTime,
      handshakeMaxAgeMs: 1_000,
    });
    registry.registerHandshake('project-a', handshake(), source);
    currentTime += 1_001;

    await expect(registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    })).resolves.toMatchObject({
      availability: 'unknown',
      reason: 'stale',
    });
    expect(reads).toBe(0);

    currentTime = now;
    registry.registerHandshake('project-a', handshake(), {
      ...source,
      identity: { projectId: 'project-b', instanceId: 'editor-1' },
    });
    await expect(registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    })).resolves.toMatchObject({
      availability: 'unknown',
      reason: 'source-identity-mismatch',
    });
    expect(reads).toBe(0);
  });

  it('requires the negotiated capability before invoking the source', async () => {
    let reads = 0;
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        reads++;
        return {
          assetScope: 'complete',
          revision: 'materials-1',
          collectedAt: now,
          materials: [],
        };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', {
      ...handshake(),
      capabilities: {
        ...handshake().capabilities,
        supportedFeatures: [],
      },
    }, source);

    await expect(registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    })).resolves.toMatchObject({
      availability: 'unknown',
      reason: 'capability-unavailable',
    });
    expect(reads).toBe(0);
  });

  it('drops an in-flight snapshot when a different Adapter instance reconnects', async () => {
    let complete!: (
      snapshot: Awaited<ReturnType<MaterialSource['materialsUsingShader']>>,
    ) => void;
    const pending = new Promise<
      Awaited<ReturnType<MaterialSource['materialsUsingShader']>>
    >((resolve) => {
      complete = resolve;
    });
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      materialsUsingShader: async () => pending,
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), source);
    const request = registry.materialsUsingShader({
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
    });

    registry.registerHandshake(
      'project-a',
      handshake('project-a', 'editor-2'),
    );
    complete({
      assetScope: 'complete',
      revision: 'materials-old',
      collectedAt: now,
      materials: [],
    });

    await expect(request).resolves.toMatchObject({
      availability: 'unknown',
      reason: 'invalid-evidence',
    });
  });

  it('requires an explicit transactional rename capability and source method', async () => {
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: 'materials-1',
          collectedAt: now,
          materials: [],
        };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), source);
    expect(registry.materialPropertyRenameAvailability()).toMatchObject({
      available: false,
      reason: expect.stringContaining('does not advertise'),
    });

    registry.registerHandshake('project-a', {
      ...handshake(),
      capabilities: {
        ...handshake().capabilities,
        supportedFeatures: [
          MATERIAL_USAGES_ADAPTER_FEATURE,
          MATERIAL_PROPERTY_RENAME_ADAPTER_FEATURE,
        ],
      },
    }, source);
    expect(registry.materialPropertyRenameAvailability()).toMatchObject({
      available: false,
      reason: expect.stringContaining('no transactional'),
    });
  });

  it('invalidates a prepared Material transaction when the Adapter reconnects', async () => {
    const commit = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    const source: MaterialSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async materialsUsingShader() {
        return {
          assetScope: 'complete',
          revision: 'materials-1',
          collectedAt: now,
          materials: [],
        };
      },
      async preparePropertyRename() {
        return {
          status: 'prepared',
          transaction: { commit, rollback },
        };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', {
      ...handshake(),
      capabilities: {
        ...handshake().capabilities,
        supportedFeatures: [
          MATERIAL_USAGES_ADAPTER_FEATURE,
          MATERIAL_PROPERTY_RENAME_ADAPTER_FEATURE,
        ],
      },
    }, source);
    const prepared = await registry.prepareMaterialPropertyRename({
      shader: { name: 'Tests/Lit', path: 'Assets/Shaders/Lit.shader' },
      oldName: '_Tint',
      newName: '_Color',
      expectedRevision: 'materials-1',
      assets: [{
        guid: '11111111111111111111111111111111',
        path: 'Assets/Materials/Ship.mat',
      }],
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;

    registry.registerHandshake(
      'project-a',
      handshake('project-a', 'editor-2'),
    );
    await expect(prepared.transaction.commit()).rejects.toThrow(
      'connection changed',
    );
    expect(commit).not.toHaveBeenCalled();
    await prepared.transaction.rollback();
    expect(rollback).toHaveBeenCalledOnce();
  });
});
