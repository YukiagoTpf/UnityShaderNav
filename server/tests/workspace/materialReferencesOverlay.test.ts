import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  DEFAULT_SETTINGS,
  MATERIAL_USAGES_ADAPTER_FEATURE,
  type AdapterHandshake,
  type MaterialReferenceLocation,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type { MaterialSource } from '../../src/adapter/materialSource';
import { Workspace } from '../../src/workspace/workspace';

const now = 1_000_000;
const fakeConnection = {
  console: { log() {}, warn() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

function handshake(): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId: 'editor-1',
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      adapterVersion: '0.2.0',
      supportedFeatures: [MATERIAL_USAGES_ADAPTER_FEATURE],
    },
  };
}

describe('Workspace Material References overlay', () => {
  it('refreshes Adapter facts without admitting the Material into source membership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-material-overlay-'));
    try {
      const shaderPath = join(root, 'Assets', 'Shaders', 'Lit.shader');
      const materialPath = join(root, 'Assets', 'Materials', 'Ship.mat');
      await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
      await mkdir(join(root, 'Assets', 'Materials'), { recursive: true });
      await mkdir(join(root, 'Packages'), { recursive: true });
      await mkdir(join(root, 'ProjectSettings'), { recursive: true });
      await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
      await writeFile(
        join(root, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 2022.3.62f1\n',
      );
      const shaderText = [
        'Shader "Tests/Lit" {',
        '  Properties {',
        '    _Tint ("Tint", Color) = (1,1,1,1)',
        '  }',
        '  SubShader {}',
        '}',
      ].join('\n');
      await writeFile(shaderPath, shaderText);
      await writeFile(materialPath, '%YAML 1.1\nMaterial:\n');

      let deleted = false;
      const source: MaterialSource = {
        identity: { projectId: 'project-a', instanceId: 'editor-1' },
        async materialsUsingShader() {
          return {
            assetScope: 'complete',
            revision: deleted ? 'materials-2' : 'materials-1',
            collectedAt: now,
            materials: deleted ? [] : [{
              guid: '11111111111111111111111111111111',
              path: 'Assets/Materials/Ship.mat',
              properties: [{
                name: '_Tint',
                type: 'vector',
                serializedValue: [1, 1, 1, 1],
              }],
            }],
          };
        },
      };
      const registry = new AdapterRegistry({ now: () => now });
      registry.registerHandshake('project-a', handshake(), source);
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        materialUsages: registry,
        releaseVersion: null,
      });
      await workspace.initialize(fakeConnection);
      const shaderUri = pathToFileURL(shaderPath).href;
      const materialUri = pathToFileURL(materialPath).href;
      const document = {
        uri: shaderUri,
        languageId: 'shaderlab',
        text: shaderText,
        openId: 1,
        version: 1,
      } as const;
      const input = {
        document,
        position: { line: 2, character: 7 },
        includeDeclaration: true,
      } as const;

      const before = await workspace.referencesAt(input);
      deleted = true;
      const after = await workspace.referencesAt(input);
      const materialReferences = (before ?? []).filter(
        (location): location is MaterialReferenceLocation => (
          location.uri === materialUri && 'data' in location
        ),
      );

      expect(materialReferences).toHaveLength(1);
      expect(after?.some((location) => location.uri === materialUri)).toBe(false);
      expect(workspace.containsIndexedUri(materialUri)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
