import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdapterCompilerEvidence,
  AdapterHandshake,
  CompileProfile,
  IncludePointContext,
} from '@unity-shader-nav/shared';
import { AdapterRegistry } from '../../src/adapter/adapterRegistry';
import { CompilerEvidenceService } from '../../src/adapter/compilerEvidenceService';

const SHADER_URI = 'file:///project/Assets/Context.shader';
const INCLUDE_URI = 'file:///project/Assets/Common.hlsl';
const PROFILE: CompileProfile = {
  name: 'd3d11',
  platform: 'StandaloneWindows64',
  graphicsApi: 'Direct3D11',
  capability: 'compile-profile/d3d11',
};
const CONTEXT: IncludePointContext = {
  id: 'context-a',
  shaderName: 'Context',
  shaderUri: SHADER_URI,
  subShaderIndex: 0,
  passIndex: 0,
  passName: 'Forward',
  stage: 'vertex',
  entryPoint: 'vert',
  includeLocation: {
    uri: SHADER_URI,
    range: {
      start: { line: 3, character: 0 },
      end: { line: 3, character: 29 },
    },
  },
  chainDepth: 1,
};

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function handshake(instanceId = 'instance-a'): AdapterHandshake {
  return {
    interfaceVersion: 1,
    issuedAt: 1_000,
    instanceId,
    capabilities: {
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      adapterVersion: '0.1.0',
      supportedFeatures: [
        'compiler-evidence',
        PROFILE.capability,
      ],
    },
  };
}

function evidence(
  shaderSource: string,
  includeSource: string,
  instanceId = 'instance-a',
): AdapterCompilerEvidence {
  const compilerText = [
    '#line 2 "Assets/Context.shader"',
    shaderSource.split('\n')[1] ?? '',
    '#line 1 "Assets/Common.hlsl"',
    includeSource.split('\n')[0] ?? '',
  ].join('\n');
  return {
    sources: [
      {
        identity: {
          uri: SHADER_URI,
          sourceId: 'shader-guid',
          contentHash: hash(shaderSource),
        },
        text: shaderSource,
        lineDirectiveNames: ['Assets/Context.shader'],
      },
      {
        identity: {
          uri: INCLUDE_URI,
          sourceId: 'include-guid',
          contentHash: hash(includeSource),
        },
        text: includeSource,
        lineDirectiveNames: ['Assets/Common.hlsl'],
      },
    ],
    documents: [
      {
        kind: 'preprocessed',
        text: compilerText,
        compilerPath: 'Temp/Context.preprocessed.hlsl',
      },
      {
        kind: 'generated',
        text: compilerText,
        compilerPath: 'Temp/Context.generated.hlsl',
      },
    ],
    provenance: {
      capability: 'compiler-evidence',
      adapterVersion: '0.1.0',
      unityVersion: '2022.3.62f1',
      projectId: 'project-a',
      instanceId,
      collectedAt: 1_000,
      sourceRevision: {
        uri: SHADER_URI,
        assetGuid: 'shader-guid',
        contentHash: hash(shaderSource),
      },
      contextId: CONTEXT.id,
      profile: PROFILE,
    },
  };
}

function scenario() {
  const sources = new Map<string, string>([
    [SHADER_URI, 'Shader "Context"\nfloat4 vert() { return 1; }'],
    [INCLUDE_URI, 'float4 Common() { return 0; }'],
  ]);
  const getCompilerEvidence = vi.fn(async () => evidence(
    sources.get(SHADER_URI)!,
    sources.get(INCLUDE_URI)!,
  ));
  const registry = new AdapterRegistry({
    now: () => 1_000,
    profileSource: { getCompileProfiles: async () => [PROFILE] },
    compilerEvidenceSource: { getCompilerEvidence },
  });
  registry.registerHandshake('project-a', handshake());
  const service = new CompilerEvidenceService({
    registry,
    selectedContextFor: async () => ({
      folderUri: 'file:///project',
      context: CONTEXT,
    }),
    sourceText: async (uri) => sources.get(uri),
  });
  return { getCompilerEvidence, registry, service, sources };
}

describe('compiler evidence service', () => {
  it('opens current preprocessed/generated documents and maps include regions both ways', async () => {
    const test = scenario();
    const result = await test.service.viewsFor(INCLUDE_URI, PROFILE);
    expect(result).toMatchObject({
      status: 'available',
      sourceUri: SHADER_URI,
      contextId: CONTEXT.id,
      stale: false,
      views: [
        { kind: 'preprocessed' },
        { kind: 'generated' },
      ],
    });
    if (result.status !== 'available') throw new Error('expected compiler views');
    const generated = result.views.find(({ kind }) => kind === 'generated')!;
    expect(test.service.virtualDocument(generated.uri)).toMatchObject({
      status: 'available',
      stale: false,
      content: expect.stringContaining(
        'UnityShaderNav GENERATED evidence — CURRENT',
      ),
    });

    expect(test.service.map({
      uri: generated.uri,
      position: { line: 5, character: 7 },
      target: 'source',
    })).toMatchObject({
      status: 'mapped',
      evidenceId: result.evidenceId,
      locations: [{
        uri: INCLUDE_URI,
        range: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 7 },
        },
        sourceIdentity: {
          sourceId: 'include-guid',
          contentHash: hash(test.sources.get(INCLUDE_URI)!),
        },
        provenance: {
          method: 'line-directive',
          evidence: result.provenance,
        },
      }],
    });
    expect(test.service.map({
      uri: INCLUDE_URI,
      position: { line: 0, character: 7 },
      target: 'preprocessed',
      evidenceId: result.evidenceId,
    })).toMatchObject({
      status: 'mapped',
      locations: [{
        uri: result.views.find(({ kind }) => kind === 'preprocessed')!.uri,
        range: {
          start: { line: 5, character: 7 },
          end: { line: 5, character: 7 },
        },
      }],
    });
  });

  it('marks old documents and mappings stale immediately on a source hash change', async () => {
    const test = scenario();
    const first = await test.service.viewsFor(INCLUDE_URI, PROFILE);
    if (first.status !== 'available') throw new Error('expected compiler views');
    const oldGenerated = first.views.find(({ kind }) => kind === 'generated')!.uri;
    const changed = 'float4 Common() { return 2; }';
    test.sources.set(INCLUDE_URI, changed);
    test.service.markSourceChanged(INCLUDE_URI, changed);

    expect(test.service.virtualDocument(oldGenerated)).toMatchObject({
      status: 'available',
      stale: true,
      staleReason: 'source-changed',
      content: expect.stringContaining(
        'STALE (source-changed) — navigation disabled',
      ),
    });
    expect(test.service.map({
      uri: oldGenerated,
      position: { line: 5, character: 0 },
      target: 'source',
    })).toMatchObject({
      status: 'stale',
      reason: 'source-changed',
      provenance: first.provenance,
    });

    const second = await test.service.viewsFor(INCLUDE_URI, PROFILE);
    expect(second).toMatchObject({ status: 'available', stale: false });
    if (second.status !== 'available') throw new Error('expected refreshed views');
    expect(second.evidenceId).not.toBe(first.evidenceId);
    expect(test.service.isCurrent(first.evidenceId)).toBe(false);
    expect(test.service.isCurrent(second.evidenceId)).toBe(true);
  });

  it('rejects internally inconsistent source hashes at the Adapter trust boundary', async () => {
    const test = scenario();
    test.getCompilerEvidence.mockImplementationOnce(async () => {
      const invalid = evidence(
        test.sources.get(SHADER_URI)!,
        test.sources.get(INCLUDE_URI)!,
      );
      return {
        ...invalid,
        sources: invalid.sources.map((source, index) => index === 1
          ? {
              ...source,
              identity: { ...source.identity, contentHash: hash('other') },
            }
          : source),
      };
    });

    await expect(test.service.viewsFor(INCLUDE_URI, PROFILE)).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid-evidence',
    });
  });

  it('invalidates old evidence when the Adapter reconnects', async () => {
    const test = scenario();
    const result = await test.service.viewsFor(INCLUDE_URI, PROFILE);
    if (result.status !== 'available') throw new Error('expected compiler views');
    test.registry.registerHandshake('project-a', handshake('instance-b'));

    expect(test.service.virtualDocument(result.views[0]!.uri)).toMatchObject({
      status: 'available',
      stale: true,
      staleReason: 'adapter-reconnected',
    });
  });

  it('invalidates only evidence in the Context selection scope', async () => {
    const test = scenario();
    const result = await test.service.viewsFor(INCLUDE_URI, PROFILE);
    if (result.status !== 'available') throw new Error('expected compiler views');

    test.service.markContextChanged('file:///other-project');
    expect(test.service.isCurrent(result.evidenceId)).toBe(true);

    test.service.markContextChanged('file:///project');
    expect(test.service.isCurrent(result.evidenceId)).toBe(false);
    expect(test.service.virtualDocument(result.views[0]!.uri)).toMatchObject({
      status: 'available',
      stale: true,
      staleReason: 'superseded',
    });

    const reselected = await test.service.viewsFor(INCLUDE_URI, PROFILE);
    expect(reselected).toMatchObject({
      status: 'available',
      evidenceId: result.evidenceId,
      stale: false,
    });
  });
});
