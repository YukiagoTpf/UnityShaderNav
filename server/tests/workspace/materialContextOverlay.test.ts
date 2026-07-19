import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  DEFAULT_SETTINGS,
  MATERIAL_CONTEXT_ADAPTER_FEATURE,
  type AdapterHandshake,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type { MaterialContextSource } from '../../src/adapter/materialContextSource';
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

function hash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function handshake(): AdapterHandshake {
  return {
    interfaceVersion: ADAPTER_INTERFACE_VERSION,
    issuedAt: now,
    instanceId: 'editor-1',
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      adapterVersion: '0.3.0',
      supportedFeatures: [MATERIAL_CONTEXT_ADAPTER_FEATURE],
    },
  };
}

interface Fixture {
  readonly root: string;
  readonly shaderPath: string;
  readonly shaderUri: string;
  readonly materialPath: string;
  readonly materialMetaPath: string;
  readonly otherShaderUri: string;
  readonly shaderText: string;
  readonly workspace: Workspace;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'usn-material-context-'));
  const shaderPath = join(root, 'Assets', 'Shaders', 'Lit.shader');
  const materialPath = join(root, 'Assets', 'Materials', 'Ship.mat');
  const otherShaderPath = join(root, 'Assets', 'Shaders', 'AOther.shader');
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
    '    _Other ("Other", Float) = 0',
    '  }',
    '  SubShader {',
    '    Pass {',
    '      Name "Forward"',
    '      HLSLPROGRAM',
    '      #pragma vertex Vert',
    '      #pragma shader_feature_local _NORMALMAP',
    '      float4 _Tint;',
    '      float _Other;',
    '      float4 UseTint() { return _Tint; }',
    '      void Vert() {',
    '        _',
    '      }',
    '      ENDHLSL',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const materialText = '%YAML 1.1\nMaterial:\n  m_Name: Ship\n';
  const otherShaderText = [
    'Shader "Tests/Other" {',
    '  Properties {',
    '    _Tint ("Tint", Color) = (0,0,0,1)',
    '  }',
    '  SubShader {}',
    '}',
  ].join('\n');
  await writeFile(shaderPath, shaderText);
  const shaderMetaPath = `${shaderPath}.meta`;
  await writeFile(
    shaderMetaPath,
    'fileFormatVersion: 2\nguid: 22222222222222222222222222222222\n',
  );
  await writeFile(otherShaderPath, otherShaderText);
  await writeFile(materialPath, materialText);
  const materialMetaPath = `${materialPath}.meta`;
  await writeFile(
    materialMetaPath,
    'fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n',
  );

  const source: MaterialContextSource = {
    identity: { projectId: 'project-a', instanceId: 'editor-1' },
    async selectedMaterialContext() {
      return {
        status: 'selected',
        selectionId: 'selection-1',
        collectedAt: now,
        material: {
          name: 'Ship',
          path: 'Assets/Materials/Ship.mat',
          revision: {
            uri: pathToFileURL(materialPath).href,
            assetGuid: '11111111111111111111111111111111',
            contentHash: hash(materialText),
          },
        },
        shader: {
          name: 'Tests/Lit',
          path: 'Assets/Shaders/Lit.shader',
          revision: {
            uri: pathToFileURL(shaderPath).href,
            assetGuid: '22222222222222222222222222222222',
            contentHash: hash(shaderText),
          },
        },
        selectedProgram: {
          subShaderIndex: 0,
          passIndex: 0,
          passName: 'Forward',
        },
        properties: [{
          name: '_Tint',
          type: 'vector',
          serializedValue: [1, 1, 1, 1],
        }],
        textures: [],
        materialKeywords: [{
          name: '_NORMALMAP',
          enabled: true,
          scope: 'local',
        }],
      };
    },
  };
  const registry = new AdapterRegistry({ now: () => now });
  registry.registerHandshake('project-a', handshake(), { materialContext: source });
  const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
    materialContext: registry,
    releaseVersion: null,
  });
  await workspace.initialize(fakeConnection);
  return {
    root,
    shaderPath,
    shaderUri: pathToFileURL(shaderPath).href,
    materialPath,
    materialMetaPath,
    otherShaderUri: pathToFileURL(otherShaderPath).href,
    shaderText,
    workspace,
  };
}

describe('Workspace selected Material Context overlay', () => {
  it('publishes only evidence bound to the current Material and Shader asset revisions', async () => {
    const test = await fixture();
    try {
      await expect(test.workspace.materialContextAt(test.shaderUri))
        .resolves.toMatchObject({
          status: 'available',
          folderUri: pathToFileURL(test.root).href,
          revision: 1,
          context: {
            selectionId: 'selection-1',
            material: { name: 'Ship' },
            shader: { name: 'Tests/Lit' },
          },
        });
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('rejects selection evidence after the Shader source revision changes', async () => {
    const test = await fixture();
    try {
      await writeFile(test.shaderPath, 'Shader "Tests/Lit" { SubShader {} }\n');

      await expect(test.workspace.materialContextAt(test.shaderUri)).resolves.toEqual({
        status: 'unavailable',
        reason: 'stale-source',
      });
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('rejects selection evidence when the current asset GUID no longer matches', async () => {
    const test = await fixture();
    try {
      await writeFile(
        test.materialMetaPath,
        'fileFormatVersion: 2\nguid: 99999999999999999999999999999999\n',
      );

      await expect(test.workspace.materialContextAt(test.shaderUri)).resolves.toEqual({
        status: 'unavailable',
        reason: 'stale-source',
      });
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('drops the overlay when the selected Material asset is deleted', async () => {
    const test = await fixture();
    try {
      await rm(test.materialPath);

      await expect(test.workspace.materialContextAt(test.shaderUri)).resolves.toEqual({
        status: 'unavailable',
        reason: 'asset-deleted',
      });
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('annotates and ranks matching completion candidates without deleting conservative results', async () => {
    const test = await fixture();
    try {
      const lines = test.shaderText.split('\n');
      const completionLine = lines.findIndex((line) => line.trim() === '_');
      const document = {
        uri: test.shaderUri,
        languageId: 'shaderlab',
        text: test.shaderText,
        openId: 1,
        version: 1,
      } as const;
      await test.workspace.updateDocument(document);
      await test.workspace.materialContextAt(test.shaderUri);
      const items = await test.workspace.completionAt({
        document,
        position: { line: completionLine, character: lines[completionLine].length },
      });
      const tint = items?.find(({ label }) => label === '_Tint');
      const other = items?.find(({ label }) => label === '_Other');

      expect(tint?.detail).toContain('Material Ship override: [1, 1, 1, 1]');
      expect(tint?.sortText).toMatch(/^0_material_/);
      expect(tint?.data).toMatchObject({
        materialContext: {
          selectionId: 'selection-1',
          provenance: {
            capability: MATERIAL_CONTEXT_ADAPTER_FEATURE,
            projectId: 'project-a',
            instanceId: 'editor-1',
          },
        },
      });
      expect(other).toBeDefined();
      expect(other?.sortText).toMatch(/^1_conservative_/);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it('ranks the selected Shader definitions first while retaining other Shader candidates', async () => {
    const test = await fixture();
    try {
      const lines = test.shaderText.split('\n');
      const useLine = lines.findIndex((line) => line.includes('return _Tint'));
      const document = {
        uri: test.shaderUri,
        languageId: 'shaderlab',
        text: test.shaderText,
        openId: 1,
        version: 1,
      } as const;
      await test.workspace.updateDocument(document);
      await test.workspace.materialContextAt(test.shaderUri);
      const links = await test.workspace.definitionAt({
        document,
        position: {
          line: useLine,
          character: lines[useLine].indexOf('_Tint') + 2,
        },
      });
      const targetUris = (links ?? []).map((candidate) => (
        'targetUri' in candidate ? candidate.targetUri : candidate.uri
      ));
      const firstOther = targetUris.indexOf(test.otherShaderUri);
      const lastSelected = targetUris.lastIndexOf(test.shaderUri);

      expect(firstOther).toBeGreaterThanOrEqual(0);
      expect(lastSelected).toBeGreaterThanOrEqual(0);
      expect(lastSelected).toBeLessThan(firstOther);
      expect(targetUris).toHaveLength((links ?? []).length);
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
