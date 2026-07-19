import { describe, expect, it } from 'vitest';
import type {
  MaterialContextResult,
  SelectedMaterialContext,
} from '@unity-shader-nav/shared';
import {
  materialContextDetails,
  materialContextStatus,
} from '../../../client/src/materialContextPresentation';

const context: SelectedMaterialContext = {
  selectionId: 'selection-7',
  material: {
    name: 'Ship',
    path: 'Assets/Materials/Ship.mat',
    revision: {
      uri: 'file:///project/Assets/Materials/Ship.mat',
      assetGuid: 'material-guid',
      contentHash: 'material-hash',
    },
  },
  shader: {
    name: 'Tests/Lit',
    path: 'Assets/Shaders/Lit.shader',
    revision: {
      uri: 'file:///project/Assets/Shaders/Lit.shader',
      assetGuid: 'shader-guid',
      contentHash: 'shader-hash',
    },
  },
  selectedProgram: { subShaderIndex: 0, passIndex: 1, passName: 'Forward' },
  properties: [{
    name: '_Tint',
    type: 'vector',
    serializedValue: [1, 0.5, 0.25, 1],
  }],
  textures: [{
    propertyName: '_BaseMap',
    texture: { name: 'Hull', guid: 'texture-guid', path: 'Assets/Textures/Hull.png' },
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
    capability: 'material-context',
    projectId: 'project-a',
    instanceId: 'editor-1',
    adapterVersion: '0.3.0',
    unityVersion: '2022.3.62f1',
    collectedAt: 1_000_000,
    sourceRevision: 'selection-7',
  },
};

const available: Extract<MaterialContextResult, { readonly status: 'available' }> = {
  status: 'available',
  folderUri: 'file:///project',
  revision: 4,
  publicationId: 'publication-4',
  context,
};

describe('client Material Context presentation', () => {
  it('shows every evidence category, provenance, and the non-draw disclaimer', () => {
    const status = materialContextStatus(available);
    const details = materialContextDetails(available);
    const searchable = [
      status.text,
      status.tooltip,
      ...details.flatMap((item) => [item.label, item.description, item.detail]),
    ].filter((value): value is string => typeof value === 'string').join('\n');

    expect(status.text).toBe('$(symbol-color) Material: Ship');
    expect(searchable).toContain('Shader: Tests/Lit');
    expect(searchable).toContain('SubShader 1 · Pass 2 "Forward"');
    expect(searchable).toContain('_Tint');
    expect(searchable).toContain('[1, 0.5, 0.25, 1]');
    expect(searchable).toContain('_BaseMap');
    expect(searchable).toContain('Hull');
    expect(searchable).toContain('_NORMALMAP');
    expect(searchable).toContain('LEGACY_FOG');
    expect(searchable).toContain('Global keywords: unknown');
    expect(searchable).toContain('Engine-added keywords: unknown');
    expect(searchable).toContain('Unity 2022.3.62f1');
    expect(searchable).toContain('Adapter 0.3.0');
    expect(searchable).toContain('project project-a');
    expect(searchable).toContain('instance editor-1');
    expect(searchable).toContain('not the final draw Context');
  });
});
