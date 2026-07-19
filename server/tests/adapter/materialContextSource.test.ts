import { describe, expect, it } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  MATERIAL_CONTEXT_ADAPTER_FEATURE,
  type AdapterHandshake,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type {
  MaterialContextSource,
  MaterialContextSourceSnapshot,
} from '../../src/adapter/materialContextSource';

const now = 1_000_000;

function handshake(instanceId = 'editor-1'): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId,
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      adapterVersion: '0.3.0',
      supportedFeatures: [MATERIAL_CONTEXT_ADAPTER_FEATURE],
    },
  };
}

function selectedSnapshot(
  selectionId = 'selection-7',
): Extract<MaterialContextSourceSnapshot, { readonly status: 'selected' }> {
  return {
    status: 'selected',
    selectionId,
    collectedAt: now,
    material: {
      name: 'Ship',
      path: 'Assets/Materials/Ship.mat',
      revision: {
        uri: 'file:///project/Assets/Materials/Ship.mat',
        assetGuid: '11111111111111111111111111111111',
        contentHash: 'material-hash',
      },
    },
    shader: {
      name: 'Tests/Lit',
      path: 'Assets/Shaders/Lit.shader',
      revision: {
        uri: 'file:///project/Assets/Shaders/Lit.shader',
        assetGuid: '22222222222222222222222222222222',
        contentHash: 'shader-hash',
      },
    },
    selectedProgram: {
      subShaderIndex: 0,
      passIndex: 1,
      passName: 'Forward',
    },
    properties: [{
      name: '_Tint',
      type: 'vector',
      serializedValue: [1, 0.5, 0.25, 1],
    }],
    textures: [{
      propertyName: '_BaseMap',
      texture: {
        name: 'Hull',
        guid: '33333333333333333333333333333333',
        path: 'Assets/Textures/Hull.png',
      },
    }],
    materialKeywords: [
      { name: '_NORMALMAP', enabled: true, scope: 'local' },
      { name: 'LEGACY_FOG', enabled: false, scope: 'legacy' },
    ],
  };
}

describe('Adapter selected Material Context trust boundary', () => {
  it('stamps current selection evidence and keeps draw-only keyword state unknown', async () => {
    const source: MaterialContextSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      async selectedMaterialContext() {
        return selectedSnapshot();
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), { materialContext: source });

    await expect(registry.selectedMaterialContext()).resolves.toEqual({
      availability: 'available',
      context: {
        selectionId: 'selection-7',
        material: {
          name: 'Ship',
          path: 'Assets/Materials/Ship.mat',
          revision: {
            uri: 'file:///project/Assets/Materials/Ship.mat',
            assetGuid: '11111111111111111111111111111111',
            contentHash: 'material-hash',
          },
        },
        shader: {
          name: 'Tests/Lit',
          path: 'Assets/Shaders/Lit.shader',
          revision: {
            uri: 'file:///project/Assets/Shaders/Lit.shader',
            assetGuid: '22222222222222222222222222222222',
            contentHash: 'shader-hash',
          },
        },
        selectedProgram: {
          subShaderIndex: 0,
          passIndex: 1,
          passName: 'Forward',
        },
        properties: [{
          name: '_Tint',
          type: 'vector',
          serializedValue: [1, 0.5, 0.25, 1],
        }],
        textures: [{
          propertyName: '_BaseMap',
          texture: {
            name: 'Hull',
            guid: '33333333333333333333333333333333',
            path: 'Assets/Textures/Hull.png',
          },
        }],
        keywords: {
          material: [
            { name: '_NORMALMAP', enabled: true, scope: 'local' },
            { name: 'LEGACY_FOG', enabled: false, scope: 'legacy' },
          ],
          global: { status: 'unknown', reason: 'draw-evidence-required' },
          engineAdded: { status: 'unknown', reason: 'draw-evidence-required' },
        },
        provenance: {
          capability: MATERIAL_CONTEXT_ADAPTER_FEATURE,
          projectId: 'project-a',
          instanceId: 'editor-1',
          adapterVersion: '0.3.0',
          unityVersion: '2022.3.62f1',
          collectedAt: now,
          sourceRevision: 'selection-7',
        },
      },
    });
  });

  it('rejects an in-flight selection from a replaced Editor instance', async () => {
    let complete!: (snapshot: MaterialContextSourceSnapshot) => void;
    const pending = new Promise<MaterialContextSourceSnapshot>((resolve) => {
      complete = resolve;
    });
    const first: MaterialContextSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      selectedMaterialContext: async () => pending,
    };
    const second: MaterialContextSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-2' },
      selectedMaterialContext: async () => selectedSnapshot('selection-new'),
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), { materialContext: first });
    const oldRequest = registry.selectedMaterialContext();

    registry.registerHandshake(
      'project-a',
      handshake('editor-2'),
      { materialContext: second },
    );
    complete(selectedSnapshot('selection-old'));

    await expect(oldRequest).resolves.toEqual({
      availability: 'unknown',
      reason: 'connection-changed',
    });
    await expect(registry.selectedMaterialContext()).resolves.toMatchObject({
      availability: 'available',
      context: {
        selectionId: 'selection-new',
        provenance: { instanceId: 'editor-2' },
      },
    });
  });

  it('invalidates a slow response when Unity reports a newer selection', async () => {
    let complete!: (snapshot: MaterialContextSourceSnapshot) => void;
    let selectionChanged!: () => void;
    const pending = new Promise<MaterialContextSourceSnapshot>((resolve) => {
      complete = resolve;
    });
    const source: MaterialContextSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      selectedMaterialContext: async () => pending,
      onDidChangeSelection(listener) {
        selectionChanged = listener;
        return { dispose() {} };
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    let notifications = 0;
    registry.onDidChangeMaterialContext(() => { notifications++; });
    registry.registerHandshake('project-a', handshake(), { materialContext: source });
    const request = registry.selectedMaterialContext();

    selectionChanged();
    complete(selectedSnapshot('selection-old'));

    await expect(request).resolves.toEqual({
      availability: 'unknown',
      reason: 'selection-changed',
    });
    expect(notifications).toBe(2);
  });

  it('rejects a foreign project source before reading selection evidence', async () => {
    let reads = 0;
    const source: MaterialContextSource = {
      identity: { projectId: 'project-b', instanceId: 'editor-1' },
      async selectedMaterialContext() {
        reads++;
        return selectedSnapshot();
      },
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), { materialContext: source });

    await expect(registry.selectedMaterialContext()).resolves.toEqual({
      availability: 'unknown',
      reason: 'source-identity-mismatch',
    });
    expect(reads).toBe(0);
  });

  it('classifies malformed runtime payloads as invalid evidence without throwing', async () => {
    const source: MaterialContextSource = {
      identity: { projectId: 'project-a', instanceId: 'editor-1' },
      selectedMaterialContext: async () => null as never,
    };
    const registry = new AdapterRegistry({ now: () => now });
    registry.registerHandshake('project-a', handshake(), { materialContext: source });

    await expect(registry.selectedMaterialContext()).resolves.toEqual({
      availability: 'unknown',
      reason: 'invalid-evidence',
    });
  });
});
