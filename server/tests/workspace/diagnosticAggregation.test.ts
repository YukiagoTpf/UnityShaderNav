import { CancellationTokenSource } from 'vscode-jsonrpc/node';
import {
  DiagnosticSeverity,
  LSPErrorCodes,
  type Diagnostic,
} from 'vscode-languageserver/node';
import { describe, expect, it } from 'vitest';
import {
  aggregateContextDiagnostics,
  analyzeKnownDiagnosticContexts,
  type DiagnosticShaderContext,
  type StaticDiagnosticProvenance,
} from '../../src/workspace/diagnosticAggregation';

const URI = 'file:///project/Assets/Shared.hlsl';
const RANGE = {
  start: { line: 4, character: 0 },
  end: { line: 4, character: 12 },
};

const FINDING: Diagnostic = {
  range: RANGE,
  severity: DiagnosticSeverity.Error,
  code: 'unresolved-entry-point',
  source: 'UnityShaderNav',
  message: "No visible function declaration resolves entry point 'Missing'.",
};

function context(id: string, stage: 'vertex' | 'fragment'): DiagnosticShaderContext {
  return {
    id,
    shader: {
      status: 'verified',
      value: { uri: 'file:///project/Assets/Owner.shader', name: 'Context/Owner' },
    },
    pass: {
      status: 'verified',
      value: { subShaderIndex: 0, passIndex: 0, passName: 'Forward' },
    },
    stage: {
      status: 'verified',
      value: { stage, entryPoint: stage === 'vertex' ? 'Vert' : 'Frag' },
    },
    includePoint: {
      status: 'verified',
      value: {
        location: { uri: 'file:///project/Assets/Owner.shader', range: RANGE },
        chainDepth: 1,
      },
    },
    keywords: {
      status: 'unverified',
      reason: 'keyword-selection-not-enumerated',
      facts: { declared: ['_FOG'] },
    },
    platform: { status: 'unverified', reason: 'adapter-evidence-unavailable' },
    graphicsApi: { status: 'unverified', reason: 'adapter-evidence-unavailable' },
  };
}

const STATIC_PROVENANCE: StaticDiagnosticProvenance = {
  kind: 'static',
  source: 'UnityShaderNav',
  revision: 7,
  publicationId: 'publication-7',
};

describe('Shader Context diagnostic aggregation', () => {
  it('groups duplicate findings by identity and counts distinct affected contexts', () => {
    const forwardVertex = context('forward-vertex', 'vertex');
    const forwardFragment = context('forward-fragment', 'fragment');
    const unaffected = context('unlit-fragment', 'fragment');

    const diagnostics = aggregateContextDiagnostics({
      uri: URI,
      knownContextCount: 3,
      omittedContextCount: 0,
      analyses: [
        {
          status: 'analyzed',
          context: forwardVertex,
          findings: [
            { diagnostic: FINDING, provenance: STATIC_PROVENANCE },
            { diagnostic: FINDING, provenance: STATIC_PROVENANCE },
          ],
        },
        {
          status: 'analyzed',
          context: forwardFragment,
          findings: [{ diagnostic: FINDING, provenance: STATIC_PROVENANCE }],
        },
        { status: 'analyzed', context: unaffected, findings: [] },
      ],
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      range: RANGE,
      code: 'unresolved-entry-point',
      source: 'UnityShaderNav',
      message: expect.stringContaining('Affected in 2 of 3 analyzed Shader Contexts.'),
      data: {
        kind: 'context-diagnostic-group',
        affectedContextCount: 2,
        analyzedContextCount: 3,
        knownContextCount: 3,
        unverifiedContextCount: 0,
        omittedContextCount: 0,
        affectedContexts: [
          expect.objectContaining({ context: forwardVertex }),
          expect.objectContaining({ context: forwardFragment }),
        ],
        unverifiedContexts: [],
      },
    });
    expect(diagnostics[0].relatedInformation).toHaveLength(2);
    expect(diagnostics[0].relatedInformation?.map(({ message }) => message)).toEqual([
      expect.stringContaining('Static revision 7'),
      expect.stringContaining('Static revision 7'),
    ]);
  });

  it('keeps partial and bounded Context coverage explicitly unverified', async () => {
    const contexts = [
      context('forward-vertex', 'vertex'),
      context('forward-fragment', 'fragment'),
      context('unlit-fragment', 'fragment'),
    ];
    const run = await analyzeKnownDiagnosticContexts({
      contexts,
      maxContexts: 2,
      contextFacts: (candidate) => candidate,
      analyze: (candidate) => candidate.id === 'forward-fragment'
        ? {
            status: 'unverified',
            context: candidate,
            reason: 'unsupported-static-stage',
          }
        : {
            status: 'analyzed',
            context: candidate,
            findings: [{ diagnostic: FINDING, provenance: STATIC_PROVENANCE }],
          },
    });

    const diagnostics = aggregateContextDiagnostics({ uri: URI, ...run });

    expect(run).toMatchObject({ knownContextCount: 3, omittedContextCount: 1 });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      message: expect.stringContaining('2 additional Contexts unverified.'),
      data: {
        affectedContextCount: 1,
        analyzedContextCount: 1,
        knownContextCount: 3,
        unverifiedContextCount: 2,
        omittedContextCount: 1,
        unverifiedContexts: [{
          context: contexts[1],
          reason: 'unsupported-static-stage',
        }],
      },
    });
    expect(diagnostics[0].relatedInformation?.at(-1)?.message).toContain(
      'Unverified · Shader Context/Owner',
    );
  });

  it('yields while analyzing the bounded Context set so cancellation can stop stale work', async () => {
    const cancellation = new CancellationTokenSource();
    const contexts = Array.from(
      { length: 16 },
      (_, index) => context(`context-${index}`, 'fragment'),
    );
    let analyzed = 0;

    const run = analyzeKnownDiagnosticContexts({
      contexts,
      cancellation: cancellation.token,
      contextFacts: (candidate) => candidate,
      analyze: (candidate) => {
        analyzed++;
        if (analyzed === 1) setImmediate(() => cancellation.cancel());
        return { status: 'analyzed', context: candidate, findings: [] };
      },
    });

    await expect(run).rejects.toMatchObject({ code: LSPErrorCodes.RequestCancelled });
    expect(analyzed).toBeLessThan(contexts.length);
    cancellation.dispose();
  });
});
