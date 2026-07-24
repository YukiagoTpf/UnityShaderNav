import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_PASS_EXPLANATION_NESTED_ITEMS,
} from '@unity-shader-nav/shared';
import {
  validatePassExplanationGraphShape,
} from '../../src/explanation/passExplanationGraphValidation';

const FIXTURE = join(
  __dirname,
  '..',
  'fixtures',
  'pass-explanation',
  'complete.json',
);

interface MutableGraph {
  schemaVersion: unknown;
  question: unknown;
  graphId: unknown;
  nodes: Array<Record<string, any>>;
  edges: Array<Record<string, any>>;
}

function completeGraph(): MutableGraph {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as MutableGraph;
}

function node(
  graph: MutableGraph,
  kind: string,
): Record<string, any> {
  const found = graph.nodes.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`fixture has no ${kind} node`);
  return found;
}

function edge(
  graph: MutableGraph,
  kind: string,
): Record<string, any> {
  const found = graph.edges.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`fixture has no ${kind} edge`);
  return found;
}

describe('Pass explanation graph shape validation', () => {
  it('accepts the complete bounded evidence fixture', () => {
    expect(validatePassExplanationGraphShape(completeGraph())).toEqual({
      ok: true,
    });
  });

  it('rejects the empty-object core graph that previously supported causality', () => {
    const graph = {
      schemaVersion: 1,
      question: 'why-pass-selected-for-current-material-context',
      graphId: 'malformed-core',
      nodes: [
        {
          id: 'material',
          kind: 'material-context',
          context: {},
        },
        {
          id: 'source',
          kind: 'source-pass',
          source: {},
          program: { passIndex: 0, stages: [{}] },
          range: {},
        },
        {
          id: 'context',
          kind: 'shader-context',
          correlation: {},
        },
      ],
      edges: [{
        id: 'decision',
        kind: 'selection-decision',
        materialNodeId: 'material',
        contextNodeId: 'context',
        sourceNodeId: 'source',
        reason: 'adapter-reported-material-pass-selection',
        decision: {},
      }],
    };

    expect(validatePassExplanationGraphShape(graph)).toMatchObject({
      ok: false,
      code: 'invalid-node',
    });
  });

  it('requires a dedicated, versioned decision provenance envelope', () => {
    const graph = completeGraph();
    edge(graph, 'selection-decision').decision.provenance.capability =
      'material-context';

    expect(validatePassExplanationGraphShape(graph)).toMatchObject({
      ok: false,
      code: 'invalid-edge',
      detail: expect.stringContaining('decision.provenance.capability'),
    });

    const noRationale = completeGraph();
    edge(noRationale, 'selection-decision').decision.rationale.facts = [];
    expect(validatePassExplanationGraphShape(noRationale)).toMatchObject({
      ok: false,
      code: 'invalid-edge',
      detail: expect.stringContaining('decision.rationale.facts'),
    });

    for (const mutate of [
      (rationale: Record<string, any>) => {
        rationale.summary = '   ';
      },
      (rationale: Record<string, any>) => {
        rationale.facts[0].name = '   ';
      },
      (rationale: Record<string, any>) => {
        rationale.facts[0].value = '   ';
      },
    ]) {
      const meaningless = completeGraph();
      mutate(edge(
        meaningless,
        'selection-decision',
      ).decision.rationale);
      expect(validatePassExplanationGraphShape(meaningless)).toMatchObject({
        ok: false,
        code: 'invalid-edge',
        detail: expect.stringContaining('must be non-empty and bounded'),
      });
    }
  });

  it('uses the shared nested evidence-array boundary', () => {
    const graph = completeGraph();
    edge(graph, 'selection-decision').decision.rationale.facts = Array.from(
      { length: MAX_PASS_EXPLANATION_NESTED_ITEMS },
      (_, index) => ({ name: `fact-${index}`, value: `${index}` }),
    );
    expect(validatePassExplanationGraphShape(graph)).toEqual({ ok: true });

    edge(graph, 'selection-decision').decision.rationale.facts.push({
      name: 'one-too-many',
      value: 'rejected',
    });
    expect(validatePassExplanationGraphShape(graph)).toMatchObject({
      ok: false,
      code: 'invalid-edge',
      detail: expect.stringContaining(
        `exceeds ${MAX_PASS_EXPLANATION_NESTED_ITEMS} items`,
      ),
    });
  });

  it('binds Material provenance to the exact selection identity', () => {
    const graph = completeGraph();
    node(
      graph,
      'material-context',
    ).context.provenance.sourceRevision = 'forged-selection-revision';

    expect(validatePassExplanationGraphShape(graph)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining(
        'provenance.sourceRevision must match context.selectionId',
      ),
    });
  });

  it('rejects stale GPU correlation and mismatched current envelopes', () => {
    const stale = completeGraph();
    node(stale, 'shader-context').correlation.status = 'stale';
    expect(validatePassExplanationGraphShape(stale)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining('correlation.status'),
    });

    const mismatched = completeGraph();
    node(mismatched, 'shader-context').correlation.context.entryPoint = 'other';
    expect(validatePassExplanationGraphShape(mismatched)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining('must exactly match evidence.context'),
    });
  });

  it('accepts both verified-trace and sanitized-fixture current envelopes', () => {
    const verified = completeGraph();
    const verifiedCorrelation = node(
      verified,
      'shader-context',
    ).correlation;
    verifiedCorrelation.traceStatus = 'verified-local-trace';
    verifiedCorrelation.traceVerification = {
      status: 'verified-local-trace',
      fileName: verifiedCorrelation.evidence.draw.trace.fileName,
      sha256: verifiedCorrelation.evidence.draw.trace.sha256,
      byteLength: verifiedCorrelation.evidence.draw.trace.byteLength,
      labels: [verifiedCorrelation.evidence.draw.label],
    };
    expect(validatePassExplanationGraphShape(verified)).toEqual({ ok: true });

    const sanitized = completeGraph();
    node(sanitized, 'shader-context').correlation.traceStatus =
      'sanitized-fixture';
    expect(validatePassExplanationGraphShape(sanitized)).toEqual({ ok: true });
  });

  it('closes mapped entry text and complete verified trace identity', () => {
    const wrongText = completeGraph();
    node(
      wrongText,
      'shader-context',
    ).correlation.evidence.mapping.expectedText = 'otherEntry';
    expect(validatePassExplanationGraphShape(wrongText)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining('expectedText'),
    });

    for (const range of [
      {
        start: { line: 20, character: 10 },
        end: { line: 20, character: 10 },
      },
      {
        start: { line: 20, character: 10 },
        end: { line: 20, character: 13 },
      },
      {
        start: { line: 20, character: 10 },
        end: { line: 21, character: 2 },
      },
    ]) {
      const wrongRange = completeGraph();
      const wrongRangeCorrelation = node(
        wrongRange,
        'shader-context',
      ).correlation;
      wrongRangeCorrelation.range = range;
      wrongRangeCorrelation.evidence.mapping.range = range;
      expect(validatePassExplanationGraphShape(wrongRange)).toMatchObject({
        ok: false,
        code: 'invalid-node',
        detail: expect.stringContaining('exactly span expectedText'),
      });
    }

    const wrongTrace = completeGraph();
    const correlation = node(wrongTrace, 'shader-context').correlation;
    correlation.traceStatus = 'verified-local-trace';
    correlation.traceVerification = {
      status: 'verified-local-trace',
      fileName: correlation.evidence.draw.trace.fileName,
      sha256: 'f'.repeat(64),
      byteLength: correlation.evidence.draw.trace.byteLength,
      labels: [correlation.evidence.draw.label],
    };
    expect(validatePassExplanationGraphShape(wrongTrace)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining('captured draw trace identity'),
    });
  });

  it.each([
    {
      name: 'source SHA-256',
      kind: 'source-pass',
      mutate(value: Record<string, any>) {
        value.source.contentHash = 'not-a-hash';
      },
      detail: 'source.contentHash',
    },
    {
      name: 'Material asset GUID',
      kind: 'material-context',
      mutate(value: Record<string, any>) {
        value.context.material.revision.assetGuid = 'not-a-guid';
      },
      detail: 'material.revision.assetGuid',
    },
    {
      name: 'GPU trace identity',
      kind: 'shader-context',
      mutate(value: Record<string, any>) {
        value.correlation.evidence.draw.trace.fileName = '../capture.gputrace';
      },
      detail: 'trace.fileName',
    },
    {
      name: 'GPU trace format',
      kind: 'shader-context',
      mutate(value: Record<string, any>) {
        value.correlation.evidence.draw.trace.fileName = 'capture.trace';
      },
      detail: '.gputrace basename',
    },
    {
      name: 'Variant build status/failure relation',
      kind: 'variant',
      mutate(value: Record<string, any>) {
        value.build.failure = {
          phase: 'build',
          message: 'must not accompany a completed build',
        };
      },
      detail: 'completed build must not contain failure',
    },
    {
      name: 'compiler record identity',
      kind: 'compiler',
      mutate(value: Record<string, any>) {
        value.record.evidenceId = 'not-a-hash';
      },
      detail: 'record.evidenceId',
    },
    {
      name: 'generated document identity',
      kind: 'generated-source',
      mutate(value: Record<string, any>) {
        value.document.contentHash = 'not-a-hash';
      },
      detail: 'document.contentHash',
    },
    {
      name: 'generated document mapping range',
      kind: 'generated-source',
      mutate(value: Record<string, any>) {
        value.document.range = {
          start: { line: 999, character: 0 },
          end: { line: 999, character: 1 },
        };
      },
      detail: 'document.range must match mapping.generatedRange',
    },
  ])('rejects malformed $name', ({ kind, mutate, detail }) => {
    const graph = completeGraph();
    mutate(node(graph, kind));

    expect(validatePassExplanationGraphShape(graph)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining(detail),
    });
  });

  it.each([
    {
      name: 'source line',
      mutate(mapping: Record<string, any>) {
        mapping.provenance.directive.sourceLine = 999;
      },
    },
    {
      name: 'source alias',
      mutate(mapping: Record<string, any>) {
        mapping.provenance.directive.sourceName = 'unrelated/Forged.shader';
      },
    },
    {
      name: 'generated character span',
      mutate(mapping: Record<string, any>) {
        mapping.range.end.character++;
      },
    },
  ])('closes the generated mapping $name', ({ mutate }) => {
    const graph = completeGraph();
    mutate(node(graph, 'generated-source').mapping);

    expect(validatePassExplanationGraphShape(graph)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining(
        'must precede and identify the exact generated/source line pair',
      ),
    });
  });

  it('validates alternate Variant failure and stale compiler record branches', () => {
    const graph = completeGraph();
    const variant = node(graph, 'variant');
    variant.build.status = 'failed';
    variant.build.failure = {
      phase: 'compilation',
      message: 'fixture build failed after retaining partial rows',
    };
    const compiler = node(graph, 'compiler');
    compiler.record.status = 'stale';
    compiler.record.reason = 'source-changed';

    expect(validatePassExplanationGraphShape(graph)).toEqual({ ok: true });
  });

  it('rejects compiler and generated virtual identities that do not close', () => {
    const compilerMismatch = completeGraph();
    node(compilerMismatch, 'compiler').record.contextId = 'other-context';
    expect(validatePassExplanationGraphShape(compilerMismatch)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining(
        'record.contextId must match record.provenance.contextId',
      ),
    });

    const generatedMismatch = completeGraph();
    node(generatedMismatch, 'generated-source').view.uri =
      'unity-shader-nav-compiler://evidence/'
      + `${'f'.repeat(64)}/generated.hlsl`;
    expect(validatePassExplanationGraphShape(generatedMismatch)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining('view.uri'),
    });
  });

  it('bounds nested evidence arrays', () => {
    const wide = completeGraph();
    node(wide, 'shader-context').correlation.context.keywords.enabled =
      Array.from({ length: 257 }, (_, index) => `KEYWORD_${index}`);
    expect(validatePassExplanationGraphShape(wide)).toMatchObject({
      ok: false,
      code: 'invalid-node',
      detail: expect.stringContaining('keywords.enabled'),
    });
  });

  it('rejects malformed ordinary links and malformed top-level graphs', () => {
    const malformedEdge = completeGraph();
    edge(malformedEdge, 'context-compiler').fromNodeId = '';
    expect(validatePassExplanationGraphShape(malformedEdge)).toMatchObject({
      ok: false,
      code: 'invalid-edge',
      detail: expect.stringContaining('fromNodeId'),
    });

    expect(validatePassExplanationGraphShape({
      schemaVersion: 1,
      question: 'why-pass-selected-for-current-material-context',
      graphId: 'bad-top-level',
      nodes: {},
      edges: [],
    })).toMatchObject({
      ok: false,
      code: 'invalid-graph',
      detail: expect.stringContaining('nodes'),
    });
  });
});
