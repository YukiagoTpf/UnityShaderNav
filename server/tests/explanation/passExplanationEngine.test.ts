import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_PASS_EXPLANATION_EDGES,
  MAX_PASS_EXPLANATION_ANSWER_BYTES,
  MAX_PASS_EXPLANATION_DISCLOSURES,
  MAX_PASS_EXPLANATION_NODES,
  MAX_PASS_EXPLANATION_PAYLOAD_BYTES,
  type MaterialContextProgram,
  type PassCausalExplanation,
  type PassExplanationContradictionCode,
  type PassExplanationEvidenceGraph,
  type PassExplanationEvidenceRequirement,
  type PassExplanationMaterialNode,
  type PassSelectionObservation,
} from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { explainPassSelection } from '../../src/explanation';

const FIXTURE_DIRECTORY = join(
  __dirname,
  '..',
  'fixtures',
  'pass-explanation',
);

interface EvaluationScenario {
  readonly base: string;
  readonly graphId: string;
  readonly removeEdgeIds?: readonly string[];
  readonly replaceMaterialSelectedProgram?: MaterialContextProgram;
  readonly expected: {
    readonly observationStatus: PassSelectionObservation['status'];
    readonly observedPassIndex?: number;
    readonly causalStatus: PassCausalExplanation['status'];
    readonly causalReason: PassCausalExplanation['reason'];
    readonly missing?: readonly PassExplanationEvidenceRequirement[];
    readonly contradictions?: readonly PassExplanationContradictionCode[];
  };
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8'));
}

function completeGraph(): PassExplanationEvidenceGraph {
  return readJson('complete.json') as PassExplanationEvidenceGraph;
}

function verifiedCompleteGraph(): PassExplanationEvidenceGraph {
  const graph = completeGraph();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (
      node.kind === 'shader-context'
        ? {
            ...node,
            correlation: {
              ...node.correlation,
              traceStatus: 'verified-local-trace',
              traceVerification: {
                status: 'verified-local-trace',
                fileName: node.correlation.evidence.draw.trace.fileName,
                sha256: node.correlation.evidence.draw.trace.sha256,
                byteLength: node.correlation.evidence.draw.trace.byteLength,
                labels: [node.correlation.evidence.draw.label],
              },
            },
          }
        : node
    )),
  };
}

function scenarioGraph(name: 'missing.json' | 'contradictory.json') {
  const scenario = readJson(name) as EvaluationScenario;
  const base = verifiedCompleteGraph();
  const removed = new Set(scenario.removeEdgeIds ?? []);
  return {
    graph: {
      ...base,
      graphId: scenario.graphId,
      nodes: base.nodes.map((node) => (
        node.kind === 'material-context'
        && scenario.replaceMaterialSelectedProgram
          ? {
              ...node,
              context: {
                ...node.context,
                selectedProgram: scenario.replaceMaterialSelectedProgram,
              },
            }
          : node
      )),
      edges: base.edges.filter(({ id }) => !removed.has(id)),
    } satisfies PassExplanationEvidenceGraph,
    expected: scenario.expected,
  };
}

describe('deterministic Pass selection explanation engine', () => {
  it('supports a causal claim only from the authoritative closed identity chain', () => {
    const answer = explainPassSelection(verifiedCompleteGraph());

    expect(answer.observation).toMatchObject({
      status: 'observed',
      materialName: 'Ship',
      shaderName: 'Tests/Ship',
      selectedProgram: {
        subShaderIndex: 0,
        passIndex: 1,
        passName: 'Forward',
      },
      citationNodeIds: ['material-ship'],
    });
    expect(answer.causalExplanation).toMatchObject({
      status: 'supported',
      reason: 'authoritative-selection-decision',
      decision: {
        id: 'decision-material-forward',
        decision: {
          decisionId: 'pass-decision-7',
          provenance: {
            capability: 'pass-selection-decision/v1',
          },
        },
      },
    });
    expect(answer.disclosures).toEqual({
      missing: [],
      contradictions: [],
    });
    expect(answer.suggestedEdits).toEqual([]);
    expect(answer.execution).toEqual({
      authority: 'deterministic-local-evidence-engine',
      locality: 'local-only',
      model: 'not-used',
      telemetry: 'none',
      retention: 'session-only',
    });
  });

  it('refuses test-only sanitized GPU evidence even when every identity link exists', () => {
    const answer = explainPassSelection(completeGraph());

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'shader-context-mismatch',
        detail: expect.stringContaining('current verified trace'),
      }),
    );
    expect(answer.citations.map(({ kind }) => kind)).toEqual([
      'source-pass',
      'material-context',
      'shader-context',
      'variant',
      'compiler',
      'generated-source',
    ]);
  });

  it('rejects a verified trace whose mapped entry text does not close', () => {
    const graph = verifiedCompleteGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'wrong-gpu-mapped-entry-text',
      nodes: graph.nodes.map((node) => (
        node.kind === 'shader-context'
          ? {
              ...node,
              correlation: {
                ...node.correlation,
                evidence: {
                  ...node.correlation.evidence,
                  mapping: {
                    ...node.correlation.evidence.mapping,
                    expectedText: 'otherEntry',
                  },
                },
              },
            }
          : node
      )),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'invalid-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'invalid-node',
        detail: expect.stringContaining('expectedText'),
      }),
    );
  });

  it('rejects a verified trace whose mapped range does not exactly span its entry point', () => {
    const graph = JSON.parse(
      JSON.stringify(verifiedCompleteGraph()),
    ) as Record<string, any>;
    graph.graphId = 'wrong-gpu-mapped-entry-range';
    const context = graph.nodes.find(
      (candidate: Record<string, unknown>) => candidate.kind === 'shader-context',
    );
    const wrongRange = {
      start: { line: 20, character: 10 },
      end: { line: 20, character: 13 },
    };
    context.correlation.range = wrongRange;
    context.correlation.evidence.mapping.range = wrongRange;

    const answer = explainPassSelection(graph);

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'invalid-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'invalid-node',
        detail: expect.stringContaining('exactly span expectedText'),
      }),
    );
  });

  it('preserves exact identity in all six citation classes', () => {
    const answer = explainPassSelection(completeGraph());

    expect(answer.citations.map(({ kind }) => kind)).toEqual([
      'source-pass',
      'material-context',
      'shader-context',
      'variant',
      'compiler',
      'generated-source',
    ]);
    const [source, material, context, variant, compiler, generated] =
      answer.citations;
    expect(source).toMatchObject({
      nodeId: 'source-forward',
      source: {
        uri: 'file:///project/Assets/Shaders/Ship.shader',
        sourceId: '22222222222222222222222222222222',
        contentHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      range: {
        start: { line: 10, character: 0 },
        end: { line: 30, character: 1 },
      },
    });
    expect(material).toMatchObject({
      nodeId: 'material-ship',
      selectionId: 'selection-7',
      shader: {
        revision: {
          assetGuid: '22222222222222222222222222222222',
          contentHash:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
      provenance: {
        projectId: 'project-a',
        instanceId: 'editor-1',
        sourceRevision: 'selection-7',
      },
    });
    expect(context).toMatchObject({
      nodeId: 'context-forward-fragment',
      correlation: {
        status: 'current',
        traceStatus: 'sanitized-fixture',
        context: {
          id: 'ctx-forward-fragment',
          passIndex: 1,
          stage: 'fragment',
          entryPoint: 'frag',
        },
        evidence: {
          draw: {
            captureId: 'capture-forward-1',
            frameIndex: 12,
            drawIndex: 48,
          },
          provenance: {
            projectId: 'project-a',
            sourceRevision: {
              assetGuid: '22222222222222222222222222222222',
            },
          },
        },
      },
    });
    expect(variant).toMatchObject({
      nodeId: 'variant-forward-fragment',
      context: {
        passIndex: 1,
        stage: 'fragment',
        graphicsApi: 'Metal',
        compileCandidates: { availability: 'available', count: '2' },
        kept: { availability: 'available', count: '1' },
      },
      build: {
        status: 'completed',
        provenance: {
          buildTarget: 'StandaloneOSX',
          sourceRevision: {
            contentHash:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
      },
    });
    expect(compiler).toMatchObject({
      nodeId: 'compiler-forward-fragment',
      record: {
        status: 'current',
        evidenceId:
          'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        provenance: {
          contextId: 'ctx-forward-fragment',
          profile: {
            name: 'Metal',
            platform: 'StandaloneOSX',
            graphicsApi: 'Metal',
          },
        },
      },
    });
    expect(generated).toMatchObject({
      nodeId: 'generated-forward-fragment',
      evidenceId:
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      view: {
        kind: 'generated',
        uri: 'unity-shader-nav-compiler://evidence/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/generated.hlsl',
      },
      document: {
        contentHash:
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
      mapping: {
        uri: 'file:///project/Assets/Shaders/Ship.shader',
        sourceIdentity: {
          sourceId: '22222222222222222222222222222222',
          contentHash:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        provenance: {
          method: 'line-directive',
          evidence: { contextId: 'ctx-forward-fragment' },
        },
      },
    });
  });

  it('joins equivalent canonical file URIs without weakening other identities', () => {
    const graph = verifiedCompleteGraph();
    const encodedUri = 'file:///project/Assets/Shaders/%53hip.shader';
    const answer = explainPassSelection({
      ...graph,
      graphId: 'canonical-uri-equivalence',
      nodes: graph.nodes.map((node) => (
        node.kind === 'material-context'
          ? {
              ...node,
              context: {
                ...node.context,
                shader: {
                  ...node.context.shader,
                  revision: {
                    ...node.context.shader.revision,
                    uri: encodedUri,
                  },
                },
              },
            }
          : node
      )),
      edges: graph.edges.map((edge) => (
        edge.kind === 'selection-decision'
          ? {
              ...edge,
              decision: {
                ...edge.decision,
                shaderRevision: {
                  ...edge.decision.shaderRevision,
                  uri: encodedUri,
                },
              },
            }
          : edge
      )),
    });

    expect(answer.disclosures.contradictions).toEqual([]);
    expect(answer.causalExplanation.status).toBe('supported');
  });

  it('refuses mismatched graphics API and stale compiler identities', () => {
    const graph = verifiedCompleteGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'corroboration-identity-mismatch',
      nodes: graph.nodes.map((node) => {
        if (node.kind === 'variant') {
          return {
            ...node,
            context: {
              ...node.context,
              graphicsApi: 'Vulkan',
            },
          };
        }
        if (node.kind === 'compiler') {
          return {
            ...node,
            record: {
              ...node.record,
              status: 'stale' as const,
              reason: 'source-changed' as const,
            },
          };
        }
        return node;
      }),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.disclosures.contradictions.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'variant-context-mismatch',
        'compiler-context-mismatch',
      ]),
    );
  });

  it('rejects a generated virtual URI that is not bound to its evidence id', () => {
    const graph = verifiedCompleteGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'foreign-generated-view',
      nodes: graph.nodes.map((node) => (
        node.kind === 'generated-source'
          ? {
              ...node,
              view: {
                ...node.view,
                uri: 'unity-shader-nav-compiler://evidence/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/generated.hlsl',
              },
            }
          : node
      )),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'invalid-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'invalid-node',
        detail: expect.stringContaining('view.uri'),
      }),
    );
  });

  it('preserves failed Variant build status as auditable optional corroboration', () => {
    const graph = verifiedCompleteGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'failed-variant-build-status',
      nodes: graph.nodes.map((node) => (
        node.kind === 'variant'
          ? {
              ...node,
              build: {
                ...node.build,
                status: 'failed' as const,
                failure: {
                  phase: 'stripping' as const,
                  message: 'fixture build stopped after validated partial rows',
                },
              },
            }
          : node
      )),
    });

    expect(answer.causalExplanation.status).toBe('supported');
    expect(answer.disclosures.contradictions).toEqual([]);
    expect(answer.citations).toContainEqual(
      expect.objectContaining({
        kind: 'variant',
        build: expect.objectContaining({
          status: 'failed',
          failure: {
            phase: 'stripping',
            message: 'fixture build stopped after validated partial rows',
          },
        }),
      }),
    );
  });

  it('refuses corroboration from another Adapter session or build platform', () => {
    const graph = verifiedCompleteGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'foreign-corroboration-session',
      nodes: graph.nodes.map((node) => {
        if (node.kind === 'variant') {
          return {
            ...node,
            build: {
              ...node.build,
              provenance: {
                ...node.build.provenance,
                adapterVersion: '2.0.0',
                buildTarget: 'iOS',
              },
            },
          };
        }
        return node;
      }),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.disclosures.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'adapter-session-mismatch' }),
        expect.objectContaining({
          code: 'compiler-profile-mismatch',
          detail: expect.stringContaining('build target'),
        }),
      ]),
    );
  });

  it('refuses a generated snapshot hash not owned by its compiler view', () => {
    const graph = verifiedCompleteGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'foreign-generated-document',
      nodes: graph.nodes.map((node) => (
        node.kind === 'generated-source'
          ? {
              ...node,
              document: {
                ...node.document,
                contentHash: 'f'.repeat(64),
              },
            }
          : node
      )),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'generated-mapping-mismatch',
      }),
    );
  });

  it('discloses a missing decision and refuses causality without erasing the observation', () => {
    const { graph, expected } = scenarioGraph('missing.json');
    const answer = explainPassSelection(graph);

    expect(answer.observation.status).toBe(expected.observationStatus);
    expect(answer.causalExplanation).toMatchObject({
      status: expected.causalStatus,
      reason: expected.causalReason,
    });
    expect(answer.disclosures.contradictions).toEqual([]);
    for (const evidence of expected.missing ?? []) {
      expect(answer.disclosures.missing).toContainEqual({
        evidence,
        blocksCausalClaim: true,
        detail: 'No authoritative Adapter selection-decision edge is present.',
      });
    }
    expect(answer.citations.map(({ kind }) => kind)).toEqual([
      'source-pass',
      'material-context',
      'shader-context',
      'variant',
      'compiler',
      'generated-source',
    ]);
  });

  it('reports contradictory Pass identities and refuses to turn the observation into a cause', () => {
    const { graph, expected } = scenarioGraph('contradictory.json');
    const answer = explainPassSelection(graph);

    expect(answer.observation).toMatchObject({
      status: expected.observationStatus,
      selectedProgram: {
        passIndex: expected.observedPassIndex,
        passName: 'ShadowCaster',
      },
    });
    expect(answer.causalExplanation).toMatchObject({
      status: expected.causalStatus,
      reason: expected.causalReason,
    });
    for (const code of expected.contradictions ?? []) {
      expect(answer.disclosures.contradictions.map(
        ({ code: actual }) => actual,
      )).toContain(code);
    }
    expect(answer.causalExplanation.statement).toContain(
      'No causal explanation is claimed',
    );
  });

  it('surfaces Material/source contradictions even when Shader Context is missing', () => {
    const graph = completeGraph();
    const materialAndSource = graph.nodes.filter(
      ({ kind }) => kind === 'material-context' || kind === 'source-pass',
    ).map((node) => (
      node.kind === 'material-context'
        ? {
            ...node,
            context: {
              ...node.context,
              selectedProgram: {
                subShaderIndex: 0,
                passIndex: 0,
                passName: 'ShadowCaster',
              },
            },
          } satisfies PassExplanationMaterialNode
        : node
    ));

    const answer = explainPassSelection({
      ...graph,
      graphId: 'partial-contradictory-material-source',
      nodes: materialAndSource,
      edges: [],
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.disclosures.missing.map(({ evidence }) => evidence)).toContain(
      'shader-context',
    );
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'selected-program-mismatch',
        nodeIds: ['material-ship', 'source-forward'],
      }),
    );
  });

  it('cites every ambiguous Material node in its structured refusal', () => {
    const graph = completeGraph();
    const material = graph.nodes.find(
      (node): node is PassExplanationMaterialNode => (
        node.kind === 'material-context'
      ),
    );
    if (!material) throw new Error('complete fixture has no Material');

    const answer = explainPassSelection({
      ...graph,
      graphId: 'ambiguous-materials',
      nodes: [
        ...graph.nodes,
        {
          ...material,
          id: 'material-second',
          context: {
            ...material.context,
            selectionId: 'selection-second',
            provenance: {
              ...material.context.provenance,
              sourceRevision: 'selection-second',
            },
          },
        },
      ],
      edges: graph.edges.filter(({ kind }) => kind !== 'selection-decision'),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.observation).toMatchObject({
      status: 'not-observed',
      reason: 'material-context-ambiguous',
      citationNodeIds: ['material-second', 'material-ship'],
    });
    expect(answer.citations.map(({ nodeId }) => nodeId)).toEqual(
      expect.arrayContaining(['material-second', 'material-ship']),
    );
  });

  it('refuses extra primary source or Shader Context evidence outside the decision', () => {
    const graph = verifiedCompleteGraph();
    const source = graph.nodes.find(({ kind }) => kind === 'source-pass');
    const context = graph.nodes.find(({ kind }) => kind === 'shader-context');
    if (!source || !context) throw new Error('complete fixture is incomplete');

    const answer = explainPassSelection({
      ...graph,
      graphId: 'ambiguous-primary-evidence',
      nodes: [
        ...graph.nodes,
        { ...source, id: 'source-second' },
        { ...context, id: 'context-second' },
      ],
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.disclosures.contradictions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'multiple-primary-evidence',
          nodeIds: ['source-forward', 'source-second'],
        }),
        expect.objectContaining({
          code: 'multiple-primary-evidence',
          nodeIds: ['context-forward-fragment', 'context-second'],
        }),
      ]),
    );
  });

  it('refuses generated evidence with more than one compiler owner', () => {
    const graph = verifiedCompleteGraph();
    const compiler = graph.nodes.find(({ kind }) => kind === 'compiler');
    const contextCompiler = graph.edges.find(
      ({ kind }) => kind === 'context-compiler',
    );
    const compilerGenerated = graph.edges.find(
      ({ kind }) => kind === 'compiler-generated',
    );
    if (!compiler || !contextCompiler || !compilerGenerated) {
      throw new Error('complete fixture is incomplete');
    }

    const answer = explainPassSelection({
      ...graph,
      graphId: 'ambiguous-compiler-owner',
      nodes: [...graph.nodes, { ...compiler, id: 'compiler-second' }],
      edges: [
        ...graph.edges,
        {
          ...contextCompiler,
          id: 'context-compiler-second',
          toNodeId: 'compiler-second',
        },
        {
          ...compilerGenerated,
          id: 'compiler-generated-second',
          fromNodeId: 'compiler-second',
        },
      ],
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'generated-mapping-mismatch',
        nodeIds: [
          'compiler-forward-fragment',
          'compiler-second',
          'generated-forward-fragment',
          'source-forward',
        ],
      }),
    );
  });

  it('keeps optional corroboration missing without blocking an authoritative causal claim', () => {
    const graph = verifiedCompleteGraph();
    const authoritativeKinds = new Set([
      'source-pass',
      'material-context',
      'shader-context',
    ]);
    const answer = explainPassSelection({
      ...graph,
      graphId: 'authoritative-chain-without-corroboration',
      nodes: graph.nodes.filter(({ kind }) => authoritativeKinds.has(kind)),
      edges: graph.edges.filter(({ kind }) => kind === 'selection-decision'),
    });

    expect(answer.causalExplanation.status).toBe('supported');
    expect(answer.disclosures.contradictions).toEqual([]);
    expect(answer.disclosures.missing).toEqual([
      {
        evidence: 'variant',
        blocksCausalClaim: false,
        detail: 'No Variant corroboration is available.',
      },
      {
        evidence: 'compiler',
        blocksCausalClaim: false,
        detail: 'No compiler corroboration is available.',
      },
      {
        evidence: 'generated-source',
        blocksCausalClaim: false,
        detail: 'No generated-source corroboration is available.',
      },
    ]);
  });

  it('is byte-for-byte deterministic when graph arrays arrive in a different order', () => {
    const graph = completeGraph();
    const reordered = {
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };

    expect(JSON.stringify(explainPassSelection(reordered))).toBe(
      JSON.stringify(explainPassSelection(graph)),
    );
  });

  it('returns a bounded invalid-evidence answer for malformed nested core facts', () => {
    const graph = completeGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'malformed-nested-material-context',
      nodes: graph.nodes.map((node) => (
        node.kind === 'material-context'
          ? { ...node, context: {} }
          : node
      )),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'invalid-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'invalid-node',
        detail: expect.stringContaining('context.selectionId'),
      }),
    );
  });

  it('refuses a forged Material selection provenance revision', () => {
    const graph = verifiedCompleteGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'forged-material-selection-revision',
      nodes: graph.nodes.map((node) => (
        node.kind === 'material-context'
          ? {
              ...node,
              context: {
                ...node.context,
                provenance: {
                  ...node.context.provenance,
                  sourceRevision: 'forged-selection-revision',
                },
              },
            }
          : node
      )),
    });

    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'invalid-evidence',
    });
    expect(answer.disclosures.contradictions).toContainEqual(
      expect.objectContaining({
        code: 'invalid-node',
        detail: expect.stringContaining(
          'provenance.sourceRevision must match context.selectionId',
        ),
      }),
    );
  });

  it('keeps every legal disclosure answer inside the shared client boundary', () => {
    const graph = completeGraph();
    const decision = graph.edges.find(
      ({ kind }) => kind === 'selection-decision',
    );
    if (!decision || decision.kind !== 'selection-decision') {
      throw new Error('complete fixture has no selection decision');
    }
    const answer = explainPassSelection({
      ...graph,
      graphId: 'many-legal-contradictions',
      edges: Array.from(
        { length: MAX_PASS_EXPLANATION_EDGES },
        (_, index) => ({
          ...decision,
          id: `decision-${index}`,
          materialNodeId: `missing-material-${index}`,
          contextNodeId: `missing-context-${index}`,
          sourceNodeId: `missing-source-${index}`,
        }),
      ),
    });

    expect(answer.disclosures.contradictions.length).toBeGreaterThan(
      MAX_PASS_EXPLANATION_EDGES,
    );
    expect(answer.disclosures.contradictions.length).toBeLessThanOrEqual(
      MAX_PASS_EXPLANATION_DISCLOSURES,
    );
    expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(
      MAX_PASS_EXPLANATION_ANSWER_BYTES,
    );
    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'contradictory-evidence',
    });
  });

  it('never reflects a non-printable invalid graph id into its refusal', () => {
    const graph = completeGraph();
    const answer = explainPassSelection({
      ...graph,
      graphId: 'bad\ngraph',
    });

    expect(answer.graphId).toBe('invalid-graph');
    expect(answer.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'invalid-evidence',
    });
  });

  it('rejects node, edge, and encoded payloads beyond their hard bounds', () => {
    const graph = completeGraph();
    const source = graph.nodes.find(({ kind }) => kind === 'source-pass');
    const edge = graph.edges.find(({ kind }) => kind === 'context-variant');
    if (!source || !edge) throw new Error('complete fixture is incomplete');

    const tooManyNodes = explainPassSelection({
      ...graph,
      nodes: Array.from(
        { length: MAX_PASS_EXPLANATION_NODES + 1 },
        (_, index) => ({ ...source, id: `source-${index}` }),
      ),
    });
    expect(tooManyNodes.disclosures.contradictions).toContainEqual(
      expect.objectContaining({ code: 'node-limit-exceeded' }),
    );

    const tooManyEdges = explainPassSelection({
      ...graph,
      edges: Array.from(
        { length: MAX_PASS_EXPLANATION_EDGES + 1 },
        (_, index) => ({ ...edge, id: `edge-${index}` }),
      ),
    });
    expect(tooManyEdges.disclosures.contradictions).toContainEqual(
      expect.objectContaining({ code: 'edge-limit-exceeded' }),
    );

    const oversizedMaterialValue = 'x'.repeat(
      MAX_PASS_EXPLANATION_PAYLOAD_BYTES,
    );
    const oversizedPayload = explainPassSelection({
      ...graph,
      nodes: graph.nodes.map((node) => (
        node.kind === 'material-context'
          ? {
              ...node,
              context: {
                ...node.context,
                properties: [{
                  name: '_Oversized',
                  type: 'texture',
                  serializedValue: oversizedMaterialValue,
                }],
              },
            } satisfies PassExplanationMaterialNode
          : node
      )),
    });
    expect(oversizedPayload.disclosures.contradictions).toContainEqual(
      expect.objectContaining({ code: 'payload-limit-exceeded' }),
    );
    expect(oversizedPayload.causalExplanation).toMatchObject({
      status: 'refused',
      reason: 'invalid-evidence',
    });
  });

  it('reports an engine defect as internal-error rather than bad project data', () => {
    // The graph passes shape validation and this module throws nothing itself,
    // so anything the evaluate catch sees is a defect here. It used to surface
    // as `invalid-graph` with no trace, telling the user to fix their evidence.
    const graph = completeGraph();
    const defect = new Error('citation projection defect');
    const reported: unknown[] = [];
    const answer = explainPassSelection(
      {
        ...graph,
        // Throw only once evaluation reads the nodes, so the graph has already
        // passed the shape check. Keyed on the frame rather than a read count so
        // it survives a change in how often the validator walks the graph.
        get nodes(): readonly unknown[] {
          if (new Error().stack?.includes('evaluateGraph')) throw defect;
          return graph.nodes;
        },
      },
      (error) => { reported.push(error); },
    );

    expect(reported).toEqual([defect]);
    expect(answer.disclosures.contradictions).toEqual([
      expect.objectContaining({ code: 'internal-error' }),
    ]);
    expect(answer.observation.statement).toContain('failed to evaluate');
    expect(answer.causalExplanation.statement).toContain('failed to evaluate');
  });
});
