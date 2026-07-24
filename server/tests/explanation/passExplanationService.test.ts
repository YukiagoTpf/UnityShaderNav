import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MATERIAL_CONTEXT_ADAPTER_FEATURE,
  type MaterialContextResult,
  type PassExplanationEvidenceGraph,
  type SelectedMaterialContext,
} from '@unity-shader-nav/shared';
import {
  LSPErrorCodes,
  type CancellationToken,
} from 'vscode-languageserver/node';
import { describe, expect, it, vi } from 'vitest';
import {
  PassExplanationService,
  WorkspacePassExplanationProjector,
  type PassExplanationGraphProvider,
} from '../../src/explanation';
import { sourceHash } from '../../src/sourceHash';

const ROOT_A_URI = 'file:///roots/a/Assets/Shared.hlsl';
const ROOT_B_URI = 'file:///roots/b/Assets/Shared.hlsl';
const SHADER_A_URI = 'file:///roots/a/Assets/Shaders/A.shader';
const SHADER_B_URI = 'file:///roots/b/Assets/Shaders/B.shader';

const SHADER_A = shaderSource('Tests/A', 'Forward', 'fragA');
const SHADER_B = shaderSource('Tests/B', 'ShadowCaster', 'fragB');

function shaderSource(
  shaderName: string,
  passName: string,
  fragmentEntry: string,
): string {
  return [
    `Shader "${shaderName}"`,
    '{',
    '  SubShader',
    '  {',
    '    Pass',
    '    {',
    `      Name "${passName}"`,
    '      HLSLPROGRAM',
    '      #pragma vertex vert',
    `      #pragma fragment ${fragmentEntry}`,
    '      float4 vert(float4 value : POSITION) : SV_POSITION { return value; }',
    `      float4 ${fragmentEntry}() : SV_Target { return 1; }`,
    '      ENDHLSL',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

function context(
  id: 'a' | 'b',
  shaderUri: string,
  source: string,
  shaderName: string,
  passName: string,
): SelectedMaterialContext {
  return {
    selectionId: `selection-${id}`,
    material: {
      name: `Material ${id.toUpperCase()}`,
      path: `Assets/Materials/${id.toUpperCase()}.mat`,
      revision: {
        uri: `file:///roots/${id}/Assets/Materials/${id.toUpperCase()}.mat`,
        assetGuid: id.repeat(32),
        contentHash: id.repeat(64),
      },
    },
    shader: {
      name: shaderName,
      path: `Assets/Shaders/${id.toUpperCase()}.shader`,
      revision: {
        uri: shaderUri,
        assetGuid: id === 'a' ? '1'.repeat(32) : '2'.repeat(32),
        contentHash: sourceHash(source),
      },
    },
    selectedProgram: {
      subShaderIndex: 0,
      passIndex: 0,
      passName,
    },
    properties: [],
    textures: [],
    keywords: {
      material: [],
      global: { status: 'unknown', reason: 'draw-evidence-required' },
      engineAdded: { status: 'unknown', reason: 'draw-evidence-required' },
    },
    provenance: {
      capability: MATERIAL_CONTEXT_ADAPTER_FEATURE,
      projectId: `project-${id}`,
      instanceId: `editor-${id}`,
      adapterVersion: '1.0.0',
      unityVersion: '6000.0.0f1',
      collectedAt: id === 'a' ? 1 : 2,
      sourceRevision: `selection-${id}`,
    },
  };
}

function available(
  folderUri: string,
  publicationId: string,
  selected: SelectedMaterialContext,
): MaterialContextResult {
  return {
    status: 'available',
    folderUri,
    revision: 1,
    publicationId,
    context: selected,
  };
}

describe('PassExplanationService', () => {
  it('accepts a complete injected evidence graph without replacing engine authority', async () => {
    const complete = JSON.parse(readFileSync(join(
      __dirname,
      '..',
      'fixtures',
      'pass-explanation',
      'complete.json',
    ), 'utf8')) as PassExplanationEvidenceGraph;
    const verified = {
      ...complete,
      nodes: complete.nodes.map((node) => (
        node.kind === 'shader-context'
          ? {
              ...node,
            correlation: {
              ...node.correlation,
              traceStatus: 'verified-local-trace' as const,
              traceVerification: {
                status: 'verified-local-trace' as const,
                fileName: node.correlation.evidence.draw.trace.fileName,
                sha256: node.correlation.evidence.draw.trace.sha256,
                byteLength: node.correlation.evidence.draw.trace.byteLength,
                labels: [node.correlation.evidence.draw.label],
              },
            },
            }
          : node
      )),
    } satisfies PassExplanationEvidenceGraph;
    const graphFor = vi.fn(async () => verified);
    const service = new PassExplanationService({ graphFor });

    const answer = await service.explain(ROOT_A_URI);

    expect(graphFor).toHaveBeenCalledWith(ROOT_A_URI, undefined);
    expect(answer.causalExplanation).toMatchObject({
      status: 'supported',
      reason: 'authoritative-selection-decision',
    });
    expect(answer.citations.map(({ kind }) => kind)).toEqual([
      'source-pass',
      'material-context',
      'shader-context',
      'variant',
      'compiler',
      'generated-source',
    ]);
  });

  it('projects current Material and exact source Pass but refuses invented causality', async () => {
    const selected = context(
      'a',
      SHADER_A_URI,
      SHADER_A,
      'Tests/A',
      'Forward',
    );
    const materialContextFor = vi.fn(async () => (
      available('file:///roots/a', 'publication-a', selected)
    ));
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: { materialContextFor },
        readSource: async (uri) => uri === SHADER_A_URI ? SHADER_A : undefined,
      }),
    );

    const answer = await service.explain(ROOT_A_URI);

    expect(materialContextFor).toHaveBeenCalledWith(ROOT_A_URI);
    expect(answer.observation).toMatchObject({
      status: 'observed',
      materialName: 'Material A',
      shaderName: 'Tests/A',
      selectedProgram: {
        subShaderIndex: 0,
        passIndex: 0,
        passName: 'Forward',
      },
    });
    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'insufficient-evidence',
    });
    expect(answer.citations.map(({ kind }) => kind)).toEqual([
      'source-pass',
      'material-context',
    ]);
    expect(answer.citations[0]).toMatchObject({
      kind: 'source-pass',
      source: {
        uri: SHADER_A_URI,
        sourceId: '1'.repeat(32),
        contentHash: sourceHash(SHADER_A),
      },
      program: {
        shaderName: 'Tests/A',
        subShaderIndex: 0,
        passIndex: 0,
        passName: 'Forward',
        stages: [
          { stage: 'vertex', entryPoint: 'vert' },
          { stage: 'fragment', entryPoint: 'fragA' },
        ],
      },
      range: {
        start: { line: 4, character: 4 },
        end: { line: 13, character: 5 },
      },
    });
    expect(answer.disclosures.missing.map(({ evidence }) => evidence)).toEqual([
      'shader-context',
      'selection-decision',
      'variant',
      'compiler',
      'generated-source',
    ]);
    expect(answer.disclosures.contradictions).toEqual([]);
  });

  it('does not cite a source Pass when the exact source revision cannot be recovered', async () => {
    const selected = context(
      'a',
      SHADER_A_URI,
      SHADER_A,
      'Tests/A',
      'Forward',
    );
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: {
          materialContextFor: async () => (
            available('file:///roots/a', 'publication-a', selected)
          ),
        },
        readSource: async () => `${SHADER_A}\n// changed`,
      }),
    );

    const answer = await service.explain(ROOT_A_URI);

    expect(answer.citations.map(({ kind }) => kind)).toEqual([
      'material-context',
    ]);
    expect(answer.disclosures.missing).toContainEqual({
      evidence: 'source-pass',
      blocksCausalClaim: true,
      detail: 'Exact source Pass evidence is absent.',
    });
  });

  it('excludes unrelated Material payload size from the explanation graph', async () => {
    const base = context(
      'a',
      SHADER_A_URI,
      SHADER_A,
      'Tests/A',
      'Forward',
    );
    const selected: SelectedMaterialContext = {
      ...base,
      properties: Array.from({ length: 300 }, (_, index) => ({
        name: `_Value${index}`,
        type: 'float' as const,
        serializedValue: index,
      })),
    };
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: {
          async materialContextFor() {
            return available('file:///roots/a', 'publication-a', selected);
          },
        },
        readSource: async () => SHADER_A,
      }),
    );

    const answer = await service.explain(ROOT_A_URI);

    expect(answer.observation.status).toBe('observed');
    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'insufficient-evidence',
    });
    expect(answer.disclosures.contradictions).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain('_Value299');
  });

  it('projects an allowlisted Material identity without unknown Adapter fields', async () => {
    const selected: any = context(
      'a',
      SHADER_A_URI,
      SHADER_A,
      'Tests/A',
      'Forward',
    );
    selected.material.privateToken = 'must-not-enter-answer';
    selected.material.revision.rawText = 'must-not-enter-answer';
    selected.shader.compilerPayload = 'must-not-enter-answer';
    selected.selectedProgram.unrelatedKeywords = ['must-not-enter-answer'];
    selected.provenance.connectionSecret = 'must-not-enter-answer';
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: {
          async materialContextFor() {
            return available('file:///roots/a', 'publication-a', selected);
          },
        },
        readSource: async () => SHADER_A,
      }),
    );

    const answer = await service.explain(ROOT_A_URI);

    expect(answer.observation.status).toBe('observed');
    expect(JSON.stringify(answer)).not.toContain('must-not-enter-answer');
  });

  it('uses publication identity for Material freshness, not source provenance', async () => {
    const selected = context(
      'a',
      SHADER_A_URI,
      SHADER_A,
      'Tests/A',
      'Forward',
    );
    let publicationId = 'publication-a-1';
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: {
          async materialContextFor() {
            return available('file:///roots/a', publicationId, selected);
          },
        },
        readSource: async () => SHADER_A,
      }),
    );

    const first = await service.explain(ROOT_A_URI);
    publicationId = 'publication-a-2';
    const second = await service.explain(ROOT_A_URI);
    const sourceCitation = (answer: typeof first) => answer.citations.find(
      ({ kind }) => kind === 'source-pass',
    );

    expect(second.graphId).not.toBe(first.graphId);
    expect(sourceCitation(second)).toEqual(sourceCitation(first));
    expect(sourceCitation(second)).toMatchObject({
      source: {
        sourceId: '1'.repeat(32),
        contentHash: sourceHash(SHADER_A),
      },
    });
  });

  it('changes graph identity when the same Material projection gains exact source evidence', async () => {
    const selected = context(
      'a',
      SHADER_A_URI,
      SHADER_A,
      'Tests/A',
      'Forward',
    );
    let sourceAvailable = false;
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: {
          async materialContextFor() {
            return available('file:///roots/a', 'publication-a', selected);
          },
        },
        readSource: async () => sourceAvailable ? SHADER_A : undefined,
      }),
    );

    const withoutSource = await service.explain(ROOT_A_URI);
    sourceAvailable = true;
    const withSource = await service.explain(ROOT_A_URI);

    expect(withSource.graphId).not.toBe(withoutSource.graphId);
    expect(withoutSource.citations.map(({ kind }) => kind)).toEqual([
      'material-context',
    ]);
    expect(withSource.citations.map(({ kind }) => kind)).toEqual([
      'source-pass',
      'material-context',
    ]);
  });

  it('keeps parallel URI projections isolated across workspace roots', async () => {
    const contexts = new Map<string, MaterialContextResult>([
      [
        ROOT_A_URI,
        available(
          'file:///roots/a',
          'publication-a',
          context('a', SHADER_A_URI, SHADER_A, 'Tests/A', 'Forward'),
        ),
      ],
      [
        ROOT_B_URI,
        available(
          'file:///roots/b',
          'publication-b',
          context('b', SHADER_B_URI, SHADER_B, 'Tests/B', 'ShadowCaster'),
        ),
      ],
    ]);
    const sources = new Map([
      [SHADER_A_URI, SHADER_A],
      [SHADER_B_URI, SHADER_B],
    ]);
    const graphProvider: PassExplanationGraphProvider =
      new WorkspacePassExplanationProjector({
        workspace: {
          async materialContextFor(uri) {
            return contexts.get(uri)
              ?? { status: 'unavailable', reason: 'source-unavailable' };
          },
        },
        readSource: async (uri) => sources.get(uri),
      });
    const service = new PassExplanationService(graphProvider);

    const [answerA, answerB] = await Promise.all([
      service.explain(ROOT_A_URI),
      service.explain(ROOT_B_URI),
    ]);

    expect(answerA.graphId).not.toBe(answerB.graphId);
    expect(answerA.observation).toMatchObject({
      status: 'observed',
      materialName: 'Material A',
      shaderName: 'Tests/A',
    });
    expect(answerB.observation).toMatchObject({
      status: 'observed',
      materialName: 'Material B',
      shaderName: 'Tests/B',
    });
    expect(answerA.citations).not.toContainEqual(
      expect.objectContaining({
        kind: 'material-context',
        selectionId: 'selection-b',
      }),
    );
    expect(answerB.citations).not.toContainEqual(
      expect.objectContaining({
        kind: 'material-context',
        selectionId: 'selection-a',
      }),
    );
  });

  it('returns a bounded structured refusal when no Material Context is available', async () => {
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: {
          async materialContextFor() {
            return { status: 'unavailable', reason: 'no-selection' };
          },
        },
      }),
    );

    const answer = await service.explain(ROOT_A_URI);

    expect(answer.observation).toMatchObject({
      status: 'not-observed',
      reason: 'material-context-missing',
    });
    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'insufficient-evidence',
    });
    expect(answer.disclosures.missing.map(({ evidence }) => evidence)).toEqual([
      'material-context',
      'source-pass',
      'shader-context',
      'selection-decision',
      'variant',
      'compiler',
      'generated-source',
    ]);
    expect(answer.citations).toEqual([]);
  });

  it('stops before source I/O when cancellation arrives after Material lookup', async () => {
    let cancelled = false;
    const selected = context(
      'a',
      SHADER_A_URI,
      SHADER_A,
      'Tests/A',
      'Forward',
    );
    const readSource = vi.fn(async () => SHADER_A);
    const cancellation = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose() {} }),
    } as CancellationToken;
    const service = new PassExplanationService(
      new WorkspacePassExplanationProjector({
        workspace: {
          async materialContextFor() {
            cancelled = true;
            return available('file:///roots/a', 'publication-a', selected);
          },
        },
        readSource,
      }),
    );

    await expect(service.explain(ROOT_A_URI, cancellation)).rejects.toMatchObject({
      code: LSPErrorCodes.RequestCancelled,
    });
    expect(readSource).not.toHaveBeenCalled();
  });
});
