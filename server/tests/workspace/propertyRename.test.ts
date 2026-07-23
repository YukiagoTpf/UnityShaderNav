import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ADAPTER_INTERFACE_VERSION,
  CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
  DEFAULT_SETTINGS,
  MATERIAL_PROPERTY_RENAME_ADAPTER_FEATURE,
  MATERIAL_USAGES_ADAPTER_FEATURE,
  type AdapterHandshake,
  type CSharpPropertyUsage,
  type Range,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import type { CSharpPropertySource } from '../../src/adapter/csharpPropertySource';
import type {
  MaterialPropertyRenameTransaction,
  MaterialSource,
} from '../../src/adapter/materialSource';
import type { CancellationToken } from 'vscode-languageserver/node';
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
      supportedFeatures: [
        MATERIAL_USAGES_ADAPTER_FEATURE,
        MATERIAL_PROPERTY_RENAME_ADAPTER_FEATURE,
        CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
      ],
    },
  };
}

function rangeOf(text: string, needle: string, occurrence = 0): Range {
  let offset = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(needle, from);
    if (offset < 0) throw new Error(`Missing fixture token: ${needle}`);
    from = offset + needle.length;
  }
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return {
    start: { line, character },
    end: { line, character: character + needle.length },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface ProjectFixture {
  readonly workspace: Workspace;
  readonly shaderUri: string;
  readonly shaderText: string;
  readonly csUri: string;
  readonly csText: string;
  readonly revision: { value: string };
  readonly materialName: { value: string };
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly commit: ReturnType<typeof vi.fn>;
  readonly rollback: ReturnType<typeof vi.fn>;
}

async function projectFixture(options: {
  readonly shaderText?: string;
  readonly csharpUsages?: (
    csUri: string,
    csText: string,
    shaderPath: string,
  ) => readonly CSharpPropertyUsage[];
  readonly materialPath?: string;
  readonly commitFails?: boolean;
  readonly onPrepare?: () => void;
} = {}): Promise<{ readonly root: string; readonly fixture: ProjectFixture }> {
  const root = await mkdtemp(join(tmpdir(), 'usn-property-rename-'));
  const shaderText = options.shaderText ?? [
    'Shader "Tests/Lit" {',
    '  Properties {',
    '    _Tint ("Tint", Color) = (1,1,1,1)',
    '  }',
    '  SubShader { Pass { HLSLPROGRAM',
    '    float4 _Tint;',
    '    float4 frag() : SV_Target { return _Tint; }',
    '  ENDHLSL } }',
    '}',
  ].join('\n');
  const csText = [
    'using UnityEngine;',
    'class Use {',
    '  void Apply(Material material) {',
    '    int tint = Shader.PropertyToID("_Tint");',
    '    material.SetColor(tint, Color.white);',
    '    material.SetColor("_Tint", Color.white);',
    '  }',
    '}',
  ].join('\n');
  const shaderPath = join(root, 'Assets', 'Shaders', 'Lit.shader');
  const csPath = join(root, 'Assets', 'Scripts', 'Use.cs');
  await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
  await mkdir(join(root, 'Assets', 'Scripts'), { recursive: true });
  await mkdir(join(root, 'Packages'), { recursive: true });
  await mkdir(join(root, 'ProjectSettings'), { recursive: true });
  await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
  await writeFile(
    join(root, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.62f1\n',
  );
  await writeFile(shaderPath, shaderText);
  await writeFile(csPath, csText);
  const shaderUri = pathToFileURL(shaderPath).href;
  const csUri = pathToFileURL(csPath).href;
  const shaderAssetPath = 'Assets/Shaders/Lit.shader';
  const revision = { value: 'materials-1' };
  const materialName = { value: '_Tint' };
  const commit = vi.fn(async () => {
    materialName.value = '_RenamedTint';
    if (options.commitFails) throw new Error('simulated commit failure');
  });
  const rollback = vi.fn(async () => {
    materialName.value = '_Tint';
  });
  const prepare = vi.fn(async (request) => {
    options.onPrepare?.();
    if (request.expectedRevision !== revision.value) {
      return { status: 'conflict', message: 'material revision changed' } as const;
    }
    const transaction: MaterialPropertyRenameTransaction = { commit, rollback };
    return { status: 'prepared', transaction } as const;
  });
  const materialSource: MaterialSource = {
    identity: { projectId: 'project-a', instanceId: 'editor-1' },
    async materialsUsingShader() {
      return {
        assetScope: 'complete',
        revision: revision.value,
        collectedAt: now,
        materials: [{
          guid: '11111111111111111111111111111111',
          path: options.materialPath ?? 'Assets/Materials/Ship.mat',
          properties: [{
            name: materialName.value,
            type: 'vector',
            serializedValue: [1, 1, 1, 1],
          }],
        }],
      };
    },
    preparePropertyRename: prepare,
  };

  const defaultUsages = (): readonly CSharpPropertyUsage[] => [{
    uri: csUri,
    range: rangeOf(csText, '_Tint', 0),
    propertyName: '_Tint',
    propertyType: 'Color',
    callKind: 'property-to-id',
    accessor: 'property-to-id',
    nameOrigin: 'direct',
    receiverType: 'Shader',
    expressionDeterminism: 'constant-string',
    bindingDeterminism: 'proven',
    shader: { name: 'Tests/Lit', path: shaderAssetPath },
    sourceRevision: { uri: csUri, contentHash: sha256(csText) },
    provenance: {
      capability: CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
      projectId: 'project-a',
      instanceId: 'editor-1',
      adapterVersion: '0.2.0',
      unityVersion: '2022.3.62f1',
      collectedAt: now,
      sourceRevision: 'csharp-1',
    },
  }, {
    uri: csUri,
    range: rangeOf(csText, 'tint', 1),
    propertyName: '_Tint',
    propertyType: 'Color',
    callKind: 'material-set',
    accessor: 'set-color',
    nameOrigin: 'property-id',
    receiverType: 'Material',
    expressionDeterminism: 'constant-string',
    bindingDeterminism: 'proven',
    shader: { name: 'Tests/Lit', path: shaderAssetPath },
    sourceRevision: { uri: csUri, contentHash: sha256(csText) },
    provenance: {
      capability: CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
      projectId: 'project-a',
      instanceId: 'editor-1',
      adapterVersion: '0.2.0',
      unityVersion: '2022.3.62f1',
      collectedAt: now,
      sourceRevision: 'csharp-1',
    },
  }, {
    uri: csUri,
    range: rangeOf(csText, '_Tint', 1),
    propertyName: '_Tint',
    propertyType: 'Color',
    callKind: 'material-set',
    accessor: 'set-color',
    nameOrigin: 'direct',
    receiverType: 'Material',
    expressionDeterminism: 'constant-string',
    bindingDeterminism: 'proven',
    shader: { name: 'Tests/Lit', path: shaderAssetPath },
    sourceRevision: { uri: csUri, contentHash: sha256(csText) },
    provenance: {
      capability: CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
      projectId: 'project-a',
      instanceId: 'editor-1',
      adapterVersion: '0.2.0',
      unityVersion: '2022.3.62f1',
      collectedAt: now,
      sourceRevision: 'csharp-1',
    },
  }];
  const csharpPropertySource: CSharpPropertySource = {
    identity: { projectId: 'project-a', instanceId: 'editor-1' },
    async csharpPropertyUsagesFor() {
      return {
        assetScope: 'complete',
        revision: 'csharp-1',
        collectedAt: now,
        usages: options.csharpUsages?.(csUri, csText, shaderAssetPath)
          ?? defaultUsages(),
      };
    },
  };
  const registry = new AdapterRegistry({ now: () => now });
  registry.registerHandshake('project-a', handshake(), {
    materialUsages: materialSource,
    csharpPropertyUsages: csharpPropertySource,
  });
  const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
    materialUsages: registry,
    materialRenames: registry,
    csharpPropertyUsages: registry,
    csharpCurrentSource: {
      async currentSourceFor(uri) {
        return uri === csUri ? { text: csText, availability: 'closed-saved' } : null;
      },
    },
    releaseVersion: null,
  });
  await workspace.initialize(fakeConnection);
  return {
    root,
    fixture: {
      workspace,
      shaderUri,
      shaderText,
      csUri,
      csText,
      revision,
      materialName,
      prepare,
      commit,
      rollback,
    },
  };
}

function renameInput(fixture: ProjectFixture) {
  return {
    document: {
      uri: fixture.shaderUri,
      languageId: 'shaderlab',
      text: fixture.shaderText,
      openId: 1,
      version: 1,
    },
    position: rangeOf(fixture.shaderText, '_Tint').start,
    newName: '_RenamedTint',
  } as const;
}

describe('Safe cross-asset Shader Property Rename', () => {
  it('groups Shader, proven C#, and Material edits and commits one transaction', async () => {
    const { root, fixture } = await projectFixture();
    try {
      const preview = await fixture.workspace.previewPropertyRenameAt(renameInput(fixture));
      if (preview.status !== 'ready') throw new Error(preview.message);
      expect(preview.preview.canApply).toBe(true);
      expect(preview.preview.groups.map((group) => group.kind)).toEqual([
        'shader-source',
        'csharp-source',
        'material-asset',
      ]);
      expect(preview.preview.groups[0].items).toEqual(expect.arrayContaining([
        expect.objectContaining({ oldText: '_Tint', newText: '_RenamedTint' }),
      ]));
      expect(preview.preview.groups[1].items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provenance: {
            kind: 'csharp-adapter',
            evidence: expect.objectContaining({ callKind: 'property-to-id' }),
          },
        }),
      ]));
      expect(preview.preview.groups[2].items).toEqual([
        expect.objectContaining({ path: 'Assets/Materials/Ship.mat' }),
      ]);

      const begin = await fixture.workspace.beginPropertyRenameAt({
        ...renameInput(fixture),
        previewId: preview.preview.previewId,
      });
      expect(begin).toMatchObject({ status: 'ready' });
      if (begin.status !== 'ready') throw new Error(begin.message);
      expect(begin.edits.filter((edit) => edit.group === 'csharp-source')).toHaveLength(2);

      await expect(fixture.workspace.finishPropertyRename(
        begin.transactionId,
        true,
      )).resolves.toEqual({ status: 'committed' });
      await expect(fixture.workspace.finishPropertyRename(
        begin.transactionId,
        true,
      )).resolves.toEqual({ status: 'committed' });
      expect(fixture.commit).toHaveBeenCalledOnce();
      expect(fixture.materialName.value).toBe('_RenamedTint');
    } finally {
      fixture.workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports dynamic C# references and Package Materials as blockers', async () => {
    const { root, fixture } = await projectFixture({
      materialPath: 'Packages/com.example/Shared.mat',
      csharpUsages: (csUri, csText, shaderPath) => [{
        uri: csUri,
        range: rangeOf(csText, '_Tint'),
        propertyName: '_Tint',
        propertyType: 'Color',
        callKind: 'material-set',
        accessor: 'set-color',
        nameOrigin: 'dynamic',
        receiverType: 'Material',
        expressionDeterminism: 'dynamic',
        bindingDeterminism: 'proven',
        shader: { name: 'Tests/Lit', path: shaderPath },
        sourceRevision: { uri: csUri, contentHash: sha256(csText) },
        provenance: {
          capability: CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
          projectId: 'project-a',
          instanceId: 'editor-1',
          adapterVersion: '0.2.0',
          unityVersion: '2022.3.62f1',
          collectedAt: now,
          sourceRevision: 'csharp-1',
        },
      }],
    });
    try {
      const preview = await fixture.workspace.previewPropertyRenameAt(renameInput(fixture));
      expect(preview).toMatchObject({
        status: 'ready',
        preview: {
          canApply: false,
          blockers: expect.arrayContaining([
            expect.objectContaining({ code: 'dynamic-reference' }),
            expect.objectContaining({ code: 'read-only-package' }),
          ]),
        },
      });
    } finally {
      fixture.workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects evidence changes between preview and begin as a conflict', async () => {
    const { root, fixture } = await projectFixture();
    try {
      const preview = await fixture.workspace.previewPropertyRenameAt(renameInput(fixture));
      if (preview.status !== 'ready') throw new Error(preview.message);
      fixture.revision.value = 'materials-2';

      await expect(fixture.workspace.beginPropertyRenameAt({
        ...renameInput(fixture),
        previewId: preview.preview.previewId,
      })).resolves.toMatchObject({
        status: 'conflict',
        message: expect.stringContaining('changed after the preview'),
      });
      expect(fixture.prepare).not.toHaveBeenCalled();
    } finally {
      fixture.workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back a prepared asset transaction when the source apply is cancelled', async () => {
    const { root, fixture } = await projectFixture();
    try {
      const preview = await fixture.workspace.previewPropertyRenameAt(renameInput(fixture));
      if (preview.status !== 'ready') throw new Error(preview.message);
      const begin = await fixture.workspace.beginPropertyRenameAt({
        ...renameInput(fixture),
        previewId: preview.preview.previewId,
      });
      if (begin.status !== 'ready') throw new Error(begin.message);

      await expect(fixture.workspace.finishPropertyRename(
        begin.transactionId,
        false,
      )).resolves.toEqual({ status: 'rolled-back' });
      expect(fixture.rollback).toHaveBeenCalledOnce();
      expect(fixture.commit).not.toHaveBeenCalled();
    } finally {
      fixture.workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back partial Material work after an Adapter commit failure', async () => {
    const { root, fixture } = await projectFixture({ commitFails: true });
    try {
      const preview = await fixture.workspace.previewPropertyRenameAt(renameInput(fixture));
      if (preview.status !== 'ready') throw new Error(preview.message);
      const begin = await fixture.workspace.beginPropertyRenameAt({
        ...renameInput(fixture),
        previewId: preview.preview.previewId,
      });
      if (begin.status !== 'ready') throw new Error(begin.message);

      await expect(fixture.workspace.finishPropertyRename(
        begin.transactionId,
        true,
      )).resolves.toMatchObject({
        status: 'failed',
        message: expect.stringContaining('rolled back'),
      });
      expect(fixture.commit).toHaveBeenCalledOnce();
      expect(fixture.rollback).toHaveBeenCalledOnce();
      expect(fixture.materialName.value).toBe('_Tint');
    } finally {
      fixture.workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back preparation when cancellation arrives before the source phase', async () => {
    let cancelled = false;
    const { root, fixture } = await projectFixture({
      onPrepare: () => { cancelled = true; },
    });
    try {
      const preview = await fixture.workspace.previewPropertyRenameAt(renameInput(fixture));
      if (preview.status !== 'ready') throw new Error(preview.message);
      const cancellation = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested: () => ({ dispose() {} }),
      } as CancellationToken;

      await expect(fixture.workspace.beginPropertyRenameAt({
        ...renameInput(fixture),
        previewId: preview.preview.previewId,
        cancellation,
      })).rejects.toMatchObject({ code: -32800 });
      expect(fixture.rollback).toHaveBeenCalledOnce();
    } finally {
      fixture.workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses ambiguous duplicate ShaderLab Property declarations before preview', async () => {
    const shaderText = [
      'Shader "Tests/Lit" {',
      '  Properties {',
      '    _Tint ("Tint", Color) = (1,1,1,1)',
      '    _Tint ("Other", Color) = (1,1,1,1)',
      '  }',
      '  SubShader {}',
      '}',
    ].join('\n');
    const { root, fixture } = await projectFixture({ shaderText });
    try {
      await expect(
        fixture.workspace.previewPropertyRenameAt(renameInput(fixture)),
      ).resolves.toMatchObject({
        status: 'failure',
        message: expect.stringContaining('ambiguous'),
      });
    } finally {
      fixture.workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
