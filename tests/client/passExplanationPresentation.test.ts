import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  MAX_PASS_EXPLANATION_NESTED_ITEMS,
  PASS_EXPLANATION_QUESTION,
  PASS_EXPLANATION_SCHEMA_VERSION,
  type PassExplanationAnswer,
} from '@unity-shader-nav/shared';

interface PresentationModule {
  readonly PassExplanationClientSession: new () => {
    snapshot(): {
      readonly status: 'idle' | 'loading' | 'ready' | 'stale' | 'failed';
      readonly sourceUri?: string;
      readonly answer?: PassExplanationAnswer;
      readonly message?: string;
    };
    sourceUris(): readonly string[];
    begin(sourceUri: string): number;
    settle(generation: number, sourceUri: string, answer: unknown): boolean;
    fail(generation: number, sourceUri: string, message: string): boolean;
    invalidate(
      reason: 'source-changed' | 'material-context-changed',
    ): boolean;
  };
  renderPassExplanationHtml(
    snapshot: {
      readonly status: 'idle' | 'loading' | 'ready' | 'stale' | 'failed';
      readonly sourceUri?: string;
      readonly answer?: PassExplanationAnswer;
      readonly message?: string;
    },
    options: { readonly nonce: string },
  ): string;
  validatePassExplanationAnswer(
    answer: unknown,
  ): asserts answer is PassExplanationAnswer;
}

const presentation = require(path.resolve(
  __dirname,
  '../../../client/out/passExplanationPresentation.js',
)) as PresentationModule;

suite('Pass explanation client presentation', () => {
  test('keeps only the newest explicit editor request', () => {
    const session = new presentation.PassExplanationClientSession();
    const firstUri = 'file:///project/Assets/First.shader';
    const secondUri = 'file:///project/Assets/Second.shader';
    const firstGeneration = session.begin(firstUri);
    const secondGeneration = session.begin(secondUri);
    const secondAnswer = supportedAnswer({ graphId: 'graph-second' });

    assert.strictEqual(
      session.settle(secondGeneration, secondUri, secondAnswer),
      true,
    );
    assert.strictEqual(
      session.settle(
        firstGeneration,
        firstUri,
        supportedAnswer({ graphId: 'graph-first' }),
      ),
      false,
    );
    assert.deepStrictEqual(session.snapshot(), {
      status: 'ready',
      sourceUri: secondUri,
      answer: secondAnswer,
    });
    assert.deepStrictEqual(
      new Set(session.sourceUris()),
      new Set([
        secondUri,
        'file:///project/Assets/Preview.shader',
        'file:///project/Assets/Preview.mat',
      ]),
    );
  });

  test('clears an answer immediately when its source or Material Context changes', () => {
    const session = new presentation.PassExplanationClientSession();
    const sourceUri = 'file:///project/Assets/Preview.shader';
    const firstGeneration = session.begin(sourceUri);
    assert.strictEqual(
      session.settle(firstGeneration, sourceUri, supportedAnswer()),
      true,
    );

    assert.strictEqual(session.invalidate('source-changed'), true);
    const sourceStale = session.snapshot();
    assert.strictEqual(sourceStale.status, 'stale');
    assert.strictEqual(sourceStale.sourceUri, sourceUri);
    assert.strictEqual(sourceStale.answer, undefined);
    assert.match(sourceStale.message ?? '', /owning source changed/);

    const secondGeneration = session.begin(sourceUri);
    assert.strictEqual(session.invalidate('material-context-changed'), true);
    assert.strictEqual(
      session.settle(secondGeneration, sourceUri, supportedAnswer()),
      false,
      'an invalidated in-flight request must remain stale',
    );
    const selectionStale = session.snapshot();
    assert.strictEqual(selectionStale.status, 'stale');
    assert.strictEqual(selectionStale.answer, undefined);
    assert.match(selectionStale.message ?? '', /Material Context selection changed/);

    const html = presentation.renderPassExplanationHtml(
      selectionStale,
      { nonce: 'stale-nonce' },
    );
    assert.match(html, /Stale · rerun required/);
    assert.match(html, /Explanation is stale/);
    assert.match(html, /No background explanation request was started/);
    assert.doesNotMatch(html, /Pass selection observed/);
  });

  test('separates observations, causal claims, exact citations, and execution policy', () => {
    const answer = supportedAnswer();
    const html = presentation.renderPassExplanationHtml(
      {
        status: 'ready',
        sourceUri: 'file:///project/Assets/Preview.shader',
        answer,
      },
      { nonce: 'unit-test-nonce' },
    );

    assert.match(html, /Observed project fact/);
    assert.match(html, /Pass selection observed/);
    assert.match(html, /Causal explanation/);
    assert.match(html, /Supported by authoritative evidence/);
    assert.match(html, /decision-edge-1/);
    assert.match(html, /pass-decision-1/);
    assert.match(html, /forward-render-path-pass-match/);
    assert.match(html, /renderPath=<code>Forward<\/code>/);
    assert.match(html, /Exact project citations/);
    assert.match(html, /source-node-1/);
    assert.match(html, /material-node-1/);
    assert.match(html, /context-node-1/);
    assert.match(html, /capture-1 · frame 3 · draw 9/);
    assert.match(html, /completed/);
    assert.match(html, new RegExp('d{64}'));
    assert.match(html, /sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(html, /22222222222222222222222222222222/);
    assert.match(html, /No missing or contradictory evidence was reported/);
    assert.match(html, /Deterministic local evidence engine/);
    assert.match(html, /Local only/);
    assert.match(html, /Language model<\/dt><dd>Not used/);
    assert.match(html, /Telemetry<\/dt><dd>None/);
    assert.match(html, /Retention<\/dt><dd>Session only/);
    assert.doesNotMatch(html, /<button|acquireVsCodeApi|apply-edit|unsafe-inline|unsafe-eval/i);
    assert.match(
      html,
      /default-src 'none'; style-src 'nonce-unit-test-nonce'; img-src 'none'; script-src 'none'; connect-src 'none';/,
    );
  });

  test('renders evidence refusal as a normal bounded answer, not a request error', () => {
    const answer = refusedAnswer();
    const html = presentation.renderPassExplanationHtml(
      {
        status: 'ready',
        sourceUri: 'file:///project/Assets/Preview.shader',
        answer,
      },
      { nonce: 'refusal-nonce' },
    );

    assert.match(html, /Cause refused/);
    assert.match(html, /Refused at the evidence boundary/);
    assert.match(html, /insufficient-evidence/);
    assert.match(html, /Missing · <code>selection-decision<\/code>/);
    assert.match(html, /Blocks the causal claim/);
    assert.match(html, /Contradiction · <code>selected-program-mismatch<\/code>/);
    assert.doesNotMatch(html, /Explanation request failed/);
  });

  test('escapes every displayed evidence value in a scriptless Webview', () => {
    const answer = supportedAnswer({
      observationStatement: '<img src=x onerror="alert(1)">',
      materialName: '</pre><script>alert(2)</script>',
    });
    const html = presentation.renderPassExplanationHtml(
      { status: 'ready', answer },
      { nonce: 'safe-nonce' },
    );

    assert.doesNotMatch(html, /<img src=x onerror=/);
    assert.doesNotMatch(html, /<script>alert\(2\)<\/script>/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;\/pre&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script(?:\s|>)/i);
  });

  test('rejects schema drift, dangling citations, and any v1 suggested edit', () => {
    const base = supportedAnswer();
    assert.doesNotThrow(() => presentation.validatePassExplanationAnswer(base));

    assert.throws(
      () => presentation.validatePassExplanationAnswer({
        ...base,
        schemaVersion: 2,
      }),
      /schema version/,
    );
    assert.throws(
      () => presentation.validatePassExplanationAnswer({
        ...base,
        causalExplanation: {
          ...base.causalExplanation,
          citationNodeIds: ['missing-node'],
        },
      }),
      /references missing citation node/,
    );
    assert.throws(
      () => presentation.validatePassExplanationAnswer({
        ...base,
        suggestedEdits: [{
          id: 'edit-1',
          title: 'Untrusted edit',
          edits: [],
          application: {
            status: 'blocked',
            requirements: [
              'accepted-preview',
              'compiler-verification',
              'test-verification',
            ],
          },
        }],
      }),
      /must not contain suggested edits/,
    );

    const boundedServerDisclosures: any = JSON.parse(JSON.stringify(
      refusedAnswer(),
    ));
    boundedServerDisclosures.disclosures.missing = Array.from(
      { length: 13 },
      (_, index) => ({
        evidence: 'generated-source-map-link',
        blocksCausalClaim: false,
        detail: `Generated mapping ${index} is absent.`,
      }),
    );
    boundedServerDisclosures.disclosures.contradictions = Array.from(
      { length: 192 },
      (_, index) => ({
        code: 'dangling-edge',
        detail: `Evidence edge ${index} has no endpoint.`,
        nodeIds: [],
        edgeIds: [`edge-${index}`],
      }),
    );
    assert.doesNotThrow(
      () => presentation.validatePassExplanationAnswer(
        boundedServerDisclosures,
      ),
    );
  });

  test('shares one nested evidence-array boundary with the server', () => {
    const answer: any = supportedAnswer();
    answer.causalExplanation.decision.decision.rationale.facts = Array.from(
      { length: MAX_PASS_EXPLANATION_NESTED_ITEMS },
      (_, index) => ({ name: `fact-${index}`, value: `${index}` }),
    );
    const correlation = answer.citations.find(
      (citation: any) => citation.kind === 'shader-context',
    ).correlation;
    correlation.traceVerification.labels = [
      correlation.evidence.draw.label,
      ...Array.from(
        { length: MAX_PASS_EXPLANATION_NESTED_ITEMS - 1 },
        (_, index) => `trace-label-${index}`,
      ),
    ];
    const keywords = Array.from(
      { length: MAX_PASS_EXPLANATION_NESTED_ITEMS },
      (_, index) => `KEYWORD_${index}`,
    );
    correlation.context.keywords.enabled = keywords;
    correlation.evidence.context.keywords.enabled = keywords;
    answer.citations.find(
      (citation: any) => citation.kind === 'variant',
    ).context.keywordSets = Array.from(
      { length: MAX_PASS_EXPLANATION_NESTED_ITEMS },
      (_, index) => ({
        keywords: [`VARIANT_${index}`],
        scope: 'local',
        stage: 'fragment',
        hasBlankOption: false,
        compileCandidates: { availability: 'available', count: '1' },
        kept: { availability: 'available', count: '1' },
      }),
    );

    assert.doesNotThrow(
      () => presentation.validatePassExplanationAnswer(answer),
    );

    answer.causalExplanation.decision.decision.rationale.facts.push({
      name: 'one-too-many',
      value: 'rejected',
    });
    assert.throws(
      () => presentation.validatePassExplanationAnswer(answer),
      /facts must be a bounded non-empty array/,
    );
  });

  test('rejects unsupported decision identity and broken endpoint closure', () => {
    const wrongCapability: any = JSON.parse(JSON.stringify(supportedAnswer()));
    wrongCapability.causalExplanation.decision.decision.provenance.capability =
      'material-context';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(wrongCapability),
      /pass-selection-decision\/v1/,
    );

    const wrongEndpoint: any = JSON.parse(JSON.stringify(supportedAnswer()));
    wrongEndpoint.causalExplanation.decision.materialNodeId = 'source-node-1';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(wrongEndpoint),
      /must cite material-context evidence/,
    );

    const missingEndpointCitation: any = JSON.parse(JSON.stringify(supportedAnswer()));
    missingEndpointCitation.causalExplanation.citationNodeIds =
      ['source-node-1', 'material-node-1'];
    assert.throws(
      () => presentation.validatePassExplanationAnswer(missingEndpointCitation),
      /absent from causal citations/,
    );

    const sanitizedContext: any = JSON.parse(JSON.stringify(supportedAnswer()));
    const sanitizedCorrelation = sanitizedContext.citations.find(
      (citation: any) => citation.kind === 'shader-context',
    ).correlation;
    sanitizedCorrelation.traceStatus = 'sanitized-fixture';
    sanitizedCorrelation.traceVerification = {
      status: 'sanitized-fixture',
    };
    assert.throws(
      () => presentation.validatePassExplanationAnswer(sanitizedContext),
      /does not match its Shader Context citation/,
    );

    const wrongRevision: any = JSON.parse(JSON.stringify(supportedAnswer()));
    wrongRevision.causalExplanation.decision.decision.shaderRevision.contentHash =
      'f'.repeat(64);
    assert.throws(
      () => presentation.validatePassExplanationAnswer(wrongRevision),
      /revisions and mapped source range do not close/,
    );

    const contradictedSupport: any = JSON.parse(JSON.stringify(supportedAnswer()));
    contradictedSupport.disclosures.contradictions = [{
      code: 'selected-program-mismatch',
      detail: 'The evidence disagrees.',
      nodeIds: ['material-node-1', 'source-node-1'],
      edgeIds: ['decision-edge-1'],
    }];
    assert.throws(
      () => presentation.validatePassExplanationAnswer(contradictedSupport),
      /Supported causal explanation cannot contain/,
    );
  });

  test('rejects unbound generated evidence, stale supported records, and malformed envelopes', () => {
    const wrongEvidenceId: any = JSON.parse(JSON.stringify(supportedAnswer()));
    const generated = wrongEvidenceId.citations.find(
      (citation: any) => citation.kind === 'generated-source',
    );
    generated.evidenceId = 'f'.repeat(64);
    generated.view.uri =
      `unity-shader-nav-compiler://evidence/${'f'.repeat(64)}/generated.hlsl`;
    assert.throws(
      () => presentation.validatePassExplanationAnswer(wrongEvidenceId),
      /no unique compiler owner/,
    );

    const wrongDocumentHash: any = JSON.parse(JSON.stringify(supportedAnswer()));
    wrongDocumentHash.citations.find(
      (citation: any) => citation.kind === 'generated-source',
    ).document.contentHash = 'f'.repeat(64);
    assert.throws(
      () => presentation.validatePassExplanationAnswer(wrongDocumentHash),
      /no unique compiler owner/,
    );

    const staleCompiler: any = JSON.parse(JSON.stringify(supportedAnswer()));
    const compiler = staleCompiler.citations.find(
      (citation: any) => citation.kind === 'compiler',
    );
    compiler.record.status = 'stale';
    compiler.record.reason = 'superseded';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(staleCompiler),
      /cannot cite a stale compiler record/,
    );

    const staleRefusal: any = JSON.parse(JSON.stringify(staleCompiler));
    staleRefusal.causalExplanation = {
      status: 'refused',
      reason: 'contradictory-evidence',
      statement: 'No causal explanation is claimed from stale compiler evidence.',
      citationNodeIds: staleCompiler.causalExplanation.citationNodeIds,
    };
    staleRefusal.disclosures.contradictions = [{
      code: 'compiler-context-mismatch',
      detail: 'Compiler evidence is stale.',
      nodeIds: ['context-node-1', 'compiler-node-1'],
      edgeIds: [],
    }];
    assert.doesNotThrow(
      () => presentation.validatePassExplanationAnswer(staleRefusal),
    );
    const staleHtml = presentation.renderPassExplanationHtml(
      {
        status: 'ready',
        sourceUri: 'file:///project/Assets/Preview.shader',
        answer: staleRefusal,
      },
      { nonce: 'stale-nonce' },
    );
    assert.match(staleHtml, /stale/);
    assert.match(staleHtml, /superseded/);

    const malformedCorrelation: any = JSON.parse(JSON.stringify(supportedAnswer()));
    const context = malformedCorrelation.citations.find(
      (citation: any) => citation.kind === 'shader-context',
    );
    context.correlation.context.id = 'different-context';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(malformedCorrelation),
      /self-consistent current correlation envelope/,
    );

    const malformedDecision: any = JSON.parse(JSON.stringify(supportedAnswer()));
    malformedDecision.causalExplanation.decision.decision.schemaVersion = 2;
    assert.throws(
      () => presentation.validatePassExplanationAnswer(malformedDecision),
      /decision.schemaVersion is unsupported/,
    );

    const traversingTrace: any = JSON.parse(JSON.stringify(supportedAnswer()));
    traversingTrace.citations.find(
      (citation: any) => citation.kind === 'shader-context',
    ).correlation.evidence.draw.trace.fileName = '../preview.gputrace';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(traversingTrace),
      /trace.fileName must be a local .*basename/,
    );

    const wrongTraceIdentity: any = JSON.parse(JSON.stringify(supportedAnswer()));
    wrongTraceIdentity.citations.find(
      (citation: any) => citation.kind === 'shader-context',
    ).correlation.traceVerification.sha256 = 'f'.repeat(64);
    assert.throws(
      () => presentation.validatePassExplanationAnswer(wrongTraceIdentity),
      /must exactly match the captured draw trace identity/,
    );

    const wrongMappedText: any = JSON.parse(JSON.stringify(supportedAnswer()));
    wrongMappedText.citations.find(
      (citation: any) => citation.kind === 'shader-context',
    ).correlation.evidence.mapping.expectedText = 'otherEntry';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(wrongMappedText),
      /self-consistent current correlation envelope/,
    );

    for (const range of [
      {
        start: { line: 20, character: 8 },
        end: { line: 20, character: 8 },
      },
      {
        start: { line: 20, character: 8 },
        end: { line: 20, character: 11 },
      },
      {
        start: { line: 20, character: 8 },
        end: { line: 21, character: 2 },
      },
    ]) {
      const wrongMappedRange: any = JSON.parse(JSON.stringify(supportedAnswer()));
      const wrongRangeCorrelation = wrongMappedRange.citations.find(
        (citation: any) => citation.kind === 'shader-context',
      ).correlation;
      wrongRangeCorrelation.range = range;
      wrongRangeCorrelation.evidence.mapping.range = range;
      assert.throws(
        () => presentation.validatePassExplanationAnswer(wrongMappedRange),
        /self-consistent current correlation envelope/,
      );
    }

    const failedWithoutFailure: any = JSON.parse(JSON.stringify(supportedAnswer()));
    failedWithoutFailure.citations.find(
      (citation: any) => citation.kind === 'variant',
    ).build.status = 'failed';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(failedWithoutFailure),
      /failed build must contain failure/,
    );

    const currentWithStaleReason: any = JSON.parse(JSON.stringify(supportedAnswer()));
    currentWithStaleReason.citations.find(
      (citation: any) => citation.kind === 'compiler',
    ).record.reason = 'superseded';
    assert.throws(
      () => presentation.validatePassExplanationAnswer(currentWithStaleReason),
      /current record must not contain a stale reason/,
    );
  });

  test('rechecks every supported corroboration join at the client boundary', () => {
    const cases: Array<{
      readonly name: string;
      readonly pattern: RegExp;
      mutate(answer: any): void;
    }> = [
      {
        name: 'foreign Shader Context URI',
        pattern: /self-consistent current correlation envelope/,
        mutate(answer) {
          const correlation = citation(answer, 'shader-context').correlation;
          correlation.uri = 'file:///foreign/Forged.shader';
          correlation.evidence.mapping.uri = correlation.uri;
        },
      },
      {
        name: 'forged Material selection revision',
        pattern: /provenance.sourceRevision must match selectionId/,
        mutate(answer) {
          citation(
            answer,
            'material-context',
          ).provenance.sourceRevision = 'forged-selection-revision';
        },
      },
      {
        name: 'foreign compiler session',
        pattern: /Compiler citation .* does not close/,
        mutate(answer) {
          citation(answer, 'compiler').record.provenance.projectId = 'foreign';
        },
      },
      {
        name: 'wrong compiler Context',
        pattern: /Compiler citation .* does not close/,
        mutate(answer) {
          const record = citation(answer, 'compiler').record;
          record.contextId = 'foreign-context';
          record.provenance.contextId = 'foreign-context';
        },
      },
      {
        name: 'wrong compiler graphics API',
        pattern: /Compiler citation .* does not close/,
        mutate(answer) {
          const record = citation(answer, 'compiler').record;
          record.profile.graphicsApi = 'Direct3D11';
          record.provenance.profile.graphicsApi = 'Direct3D11';
        },
      },
      {
        name: 'foreign Variant session',
        pattern: /Variant citation .* does not close/,
        mutate(answer) {
          citation(answer, 'variant').build.provenance.instanceId = 'foreign';
        },
      },
      {
        name: 'wrong Variant graphics API',
        pattern: /Variant citation .* does not close/,
        mutate(answer) {
          citation(answer, 'variant').context.graphicsApi = 'Direct3D11';
        },
      },
      {
        name: 'Variant/compiler platform mismatch',
        pattern: /disagree on platform/,
        mutate(answer) {
          citation(answer, 'variant').build.provenance.buildTarget =
            'StandaloneWindows64';
        },
      },
      {
        name: 'foreign generated provenance',
        pattern: /no unique compiler owner/,
        mutate(answer) {
          citation(
            answer,
            'generated-source',
          ).mapping.provenance.evidence.projectId = 'foreign';
        },
      },
      {
        name: 'foreign generated source',
        pattern: /exact source mapping/,
        mutate(answer) {
          const generated = citation(answer, 'generated-source');
          generated.mapping.uri = 'file:///foreign/Forged.shader';
          generated.mapping.sourceIdentity.uri = generated.mapping.uri;
          generated.mapping.provenance.directive.sourceName =
            'foreign/Forged.shader';
        },
      },
    ];

    for (const { name, pattern, mutate } of cases) {
      const answer: any = JSON.parse(JSON.stringify(supportedAnswer()));
      mutate(answer);
      assert.throws(
        () => presentation.validatePassExplanationAnswer(answer),
        pattern,
        name,
      );
    }
  });

  test('requires a meaningful rationale and exact generated mapping pair', () => {
    for (const field of ['summary', 'fact-name', 'fact-value'] as const) {
      const answer: any = JSON.parse(JSON.stringify(supportedAnswer()));
      const rationale =
        answer.causalExplanation.decision.decision.rationale;
      if (field === 'summary') rationale.summary = '   ';
      if (field === 'fact-name') rationale.facts[0].name = '   ';
      if (field === 'fact-value') rationale.facts[0].value = '   ';
      assert.throws(
        () => presentation.validatePassExplanationAnswer(answer),
        /must be non-empty and bounded/,
      );
    }

    for (const mutate of [
      (generated: any) => {
        generated.mapping.provenance.directive.sourceLine++;
      },
      (generated: any) => {
        generated.mapping.provenance.directive.sourceName =
          'unrelated/Forged.shader';
      },
      (generated: any) => {
        generated.mapping.range.end.character++;
      },
    ]) {
      const answer: any = JSON.parse(JSON.stringify(supportedAnswer()));
      mutate(citation(answer, 'generated-source'));
      assert.throws(
        () => presentation.validatePassExplanationAnswer(answer),
        /exact generated\/source line pair/,
      );
    }
  });

  test('accepts a compiler citation sharing its evidenceId with the generated owner', () => {
    const answer: any = JSON.parse(JSON.stringify(supportedAnswer()));
    const owner: any = citation(answer, 'compiler');
    const sibling = JSON.parse(JSON.stringify(owner));
    sibling.nodeId = 'compiler-node-2';
    // Same evidenceId and view URI as the owner (the client pins view URIs to
    // the evidenceId), but a different content hash: this record compiled the
    // capture under another profile and does not own the generated document.
    sibling.record.views = [{
      kind: 'generated',
      uri: owner.record.views[0].uri,
      contentHash: 'f'.repeat(64),
    }];
    answer.citations.push(sibling);
    answer.causalExplanation.citationNodeIds = [
      ...answer.causalExplanation.citationNodeIds,
      'compiler-node-2',
    ];

    assert.doesNotThrow(
      () => presentation.validatePassExplanationAnswer(answer),
    );
  });

  test('rejects a generated citation with two fully matching compiler owners', () => {
    const answer: any = JSON.parse(JSON.stringify(supportedAnswer()));
    const owner: any = citation(answer, 'compiler');
    const twin = JSON.parse(JSON.stringify(owner));
    twin.nodeId = 'compiler-node-2';
    answer.citations.push(twin);
    answer.causalExplanation.citationNodeIds = [
      ...answer.causalExplanation.citationNodeIds,
      'compiler-node-2',
    ];

    assert.throws(
      () => presentation.validatePassExplanationAnswer(answer),
      /no unique compiler owner/,
    );
  });
});

function citation(answer: any, kind: string): any {
  const found = answer.citations.find((candidate: any) => (
    candidate.kind === kind
  ));
  if (!found) throw new Error(`answer has no ${kind} citation`);
  return found;
}

function supportedAnswer(overrides: {
  readonly graphId?: string;
  readonly observationStatement?: string;
  readonly materialName?: string;
} = {}): PassExplanationAnswer {
  const sourceUri = 'file:///project/Assets/Preview.shader';
  const materialUri = 'file:///project/Assets/Preview.mat';
  const collectedAt = Date.UTC(2026, 6, 24, 0, 0, 0);
  const program = {
    subShaderIndex: 0,
    passIndex: 0,
    passName: 'Forward',
  } as const;
  const shaderRevision = {
    uri: sourceUri,
    assetGuid: '11111111111111111111111111111111',
    contentHash: 'a'.repeat(64),
  } as const;
  const materialRevision = {
    uri: materialUri,
    assetGuid: '22222222222222222222222222222222',
    contentHash: 'b'.repeat(64),
  } as const;
  const context = {
    id: 'context-1',
    shaderName: 'Custom/Preview',
    ...program,
    stage: 'fragment',
    entryPoint: 'frag',
    keywords: {
      enabled: ['_NORMALMAP'],
      incomplete: false,
    },
  } as const;
  const mappedRange = {
    start: { line: 20, character: 8 },
    end: { line: 20, character: 12 },
  } as const;
  const gpuProvenance = {
    capability: 'gpu-capture-correlation/v1',
    adapterVersion: '1.0.0',
    unityVersion: '2022.3.62f1',
    unityBinaryVersion: '2022.3.62f1',
    projectId: 'project-1',
    instanceId: 'editor-1',
    collectedAt: collectedAt + 1,
    platform: {
      operatingSystem: 'macOS',
      operatingSystemVersion: '26.3',
      architecture: 'arm64',
    },
    gpu: {
      name: 'Test GPU',
      driverVersion: 'driver-1',
    },
    graphicsApi: 'Metal',
    tool: {
      name: 'Xcode Metal Frame Debugger',
      version: '26.6',
      buildVersion: '17F113',
      metalCompilerVersion: 'metal-1',
      traceFormat: 'gputrace',
    },
    sourceRevision: shaderRevision,
  } as const;
  const profile = {
    name: 'Metal',
    platform: 'StandaloneOSX',
    graphicsApi: 'Metal',
    capability: 'compiler-evidence',
  } as const;
  const compilerProvenance = {
    capability: 'compiler-evidence',
    adapterVersion: '1.0.0',
    unityVersion: '2022.3.62f1',
    projectId: 'project-1',
    instanceId: 'editor-1',
    collectedAt: collectedAt + 3,
    sourceRevision: shaderRevision,
    contextId: context.id,
    profile,
  } as const;
  const evidenceId = 'd'.repeat(64);
  const generatedUri =
    `unity-shader-nav-compiler://evidence/${evidenceId}/generated.hlsl`;
  const causalCitationNodeIds = [
    'source-node-1',
    'material-node-1',
    'context-node-1',
    'variant-node-1',
    'compiler-node-1',
    'generated-node-1',
  ] as const;
  return {
    schemaVersion: PASS_EXPLANATION_SCHEMA_VERSION,
    question: PASS_EXPLANATION_QUESTION,
    graphId: overrides.graphId ?? 'graph-1',
    observation: {
      status: 'observed',
      statement: overrides.observationStatement
        ?? 'Preview Material selects Forward in SubShader 0, Pass 0.',
      materialName: overrides.materialName ?? 'Preview Material',
      shaderName: 'Custom/Preview',
      selectedProgram: program,
      citationNodeIds: ['material-node-1'],
    },
    causalExplanation: {
      status: 'supported',
      reason: 'authoritative-selection-decision',
      statement: 'The active forward render path matched this Pass.',
      decision: {
        id: 'decision-edge-1',
        kind: 'selection-decision',
        materialNodeId: 'material-node-1',
        contextNodeId: 'context-node-1',
        sourceNodeId: 'source-node-1',
        reason: 'adapter-reported-material-pass-selection',
        decision: {
          schemaVersion: 1,
          decisionId: 'pass-decision-1',
          selectionId: 'selection-1',
          program,
          materialRevision,
          shaderRevision,
          contextId: context.id,
          rationale: {
            schemaVersion: 1,
            ruleId: 'forward-render-path-pass-match',
            summary: 'The active forward render path matched this Pass.',
            facts: [
              { name: 'renderPath', value: 'Forward' },
              { name: 'passName', value: 'Forward' },
            ],
          },
          provenance: {
            capability: 'pass-selection-decision/v1',
            projectId: 'project-1',
            instanceId: 'editor-1',
            adapterVersion: '1.0.0',
            unityVersion: '2022.3.62f1',
            collectedAt: collectedAt + 1,
          },
        },
      },
      citationNodeIds: causalCitationNodeIds,
    },
    disclosures: {
      missing: [],
      contradictions: [],
    },
    citations: [
      {
        nodeId: 'source-node-1',
        kind: 'source-pass',
        source: {
          uri: sourceUri,
          sourceId: shaderRevision.assetGuid,
          contentHash: 'a'.repeat(64),
        },
        program: {
          blockIndex: 0,
          shaderName: 'Custom/Preview',
          ...program,
          stages: [{
            stage: 'fragment',
            entryPoint: 'frag',
            defines: [],
          }],
          sharedBlockIndices: [],
        },
        range: {
          start: { line: 10, character: 2 },
          end: { line: 26, character: 3 },
        },
      },
      {
        nodeId: 'material-node-1',
        kind: 'material-context',
        selectionId: 'selection-1',
        material: {
          name: overrides.materialName ?? 'Preview Material',
          path: 'Assets/Preview.mat',
          revision: {
            ...materialRevision,
          },
        },
        shader: {
          name: 'Custom/Preview',
          path: 'Assets/Preview.shader',
          revision: {
            ...shaderRevision,
          },
        },
        selectedProgram: program,
        provenance: {
          capability: 'material-context',
          projectId: 'project-1',
          instanceId: 'editor-1',
          adapterVersion: '1.0.0',
          unityVersion: '2022.3.62f1',
          collectedAt,
          sourceRevision: 'selection-1',
        },
      },
      {
        nodeId: 'context-node-1',
        kind: 'shader-context',
        correlation: {
          status: 'current',
          traceStatus: 'verified-local-trace',
          traceVerification: {
            status: 'verified-local-trace',
            fileName: 'preview.gputrace',
            sha256: 'c'.repeat(64),
            byteLength: 4096,
            labels: ['Preview Forward'],
          },
          evidence: {
            schemaVersion: 1,
            provenance: gpuProvenance,
            draw: {
              captureId: 'capture-1',
              frameIndex: 3,
              drawIndex: 9,
              label: 'Preview Forward',
              trace: {
                storage: 'local-ephemeral',
                fileName: 'preview.gputrace',
                sha256: 'c'.repeat(64),
                byteLength: 4096,
              },
            },
            context,
            mapping: {
              status: 'mapped',
              method: 'adapter-exact-source-range',
              uri: sourceUri,
              range: mappedRange,
              expectedText: 'frag',
              sourceEntryPoint: 'frag',
            },
          },
          uri: sourceUri,
          range: mappedRange,
          context,
        },
      },
      {
        nodeId: 'variant-node-1',
        kind: 'variant',
        build: {
          status: 'completed',
          provenance: {
            capability: 'variant-build-evidence',
            projectId: 'project-1',
            instanceId: 'editor-1',
            adapterVersion: '1.0.0',
            unityVersion: '2022.3.62f1',
            buildTarget: 'StandaloneOSX',
            collectedAt: collectedAt + 2,
            sourceRevision: shaderRevision,
          },
        },
        context: {
          shaderName: 'Custom/Preview',
          ...program,
          stage: 'fragment',
          graphicsApi: 'Metal',
          compileCandidates: {
            availability: 'available',
            count: '2',
          },
          kept: {
            availability: 'available',
            count: '1',
          },
          keywordSets: [{
            keywords: ['_NORMALMAP'],
            scope: 'local',
            stage: 'fragment',
            hasBlankOption: true,
            compileCandidates: {
              availability: 'available',
              count: '2',
            },
            kept: {
              availability: 'available',
              count: '1',
            },
          }],
        },
      },
      {
        nodeId: 'compiler-node-1',
        kind: 'compiler',
        record: {
          status: 'current',
          evidenceId,
          sourceUri,
          contextId: context.id,
          profile,
          views: [{
            kind: 'generated',
            uri: generatedUri,
            contentHash: 'e'.repeat(64),
          }],
          provenance: compilerProvenance,
        },
      },
      {
        nodeId: 'generated-node-1',
        kind: 'generated-source',
        evidenceId,
        view: {
          kind: 'generated',
          uri: generatedUri,
        },
        document: {
          contentHash: 'e'.repeat(64),
          range: {
            start: { line: 41, character: 8 },
            end: { line: 41, character: 12 },
          },
        },
        mapping: {
          uri: sourceUri,
          range: mappedRange,
          generatedRange: {
            start: { line: 41, character: 8 },
            end: { line: 41, character: 12 },
          },
          sourceIdentity: {
            uri: sourceUri,
            sourceId: shaderRevision.assetGuid,
            contentHash: 'a'.repeat(64),
          },
          provenance: {
            method: 'line-directive',
            granularity: 'line',
            evidence: compilerProvenance,
            directive: {
              documentLine: 40,
              sourceLine: 20,
              sourceName: 'Assets/Preview.shader',
            },
          },
        },
      },
    ],
    suggestedEdits: [],
    execution: {
      authority: 'deterministic-local-evidence-engine',
      locality: 'local-only',
      model: 'not-used',
      telemetry: 'none',
      retention: 'session-only',
    },
  };
}

function refusedAnswer(): PassExplanationAnswer {
  const base = supportedAnswer();
  const citations: any[] = JSON.parse(JSON.stringify(base.citations));
  delete citation(
    { citations },
    'material-context',
  ).selectedProgram;
  return {
    ...base,
    observation: {
      status: 'not-observed',
      reason: 'selected-program-unavailable',
      statement: 'The selected Material did not report a selected Pass.',
      citationNodeIds: ['material-node-1'],
    },
    causalExplanation: {
      status: 'refused',
      reason: 'insufficient-evidence',
      statement: 'No cause is claimed without an authoritative selection decision.',
      citationNodeIds: ['material-node-1'],
    },
    disclosures: {
      missing: [{
        evidence: 'selection-decision',
        blocksCausalClaim: true,
        detail: 'No Adapter-authored selection decision is available.',
      }],
      contradictions: [{
        code: 'selected-program-mismatch',
        detail: 'The Material and source Pass identities do not match.',
        nodeIds: ['material-node-1', 'source-node-1'],
        edgeIds: [],
      }],
    },
    citations,
  };
}
