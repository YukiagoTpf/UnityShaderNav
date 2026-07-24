import {
  COMPILER_EVIDENCE_CAPABILITY,
  GPU_CAPTURE_CORRELATION_CAPABILITY,
  MATERIAL_CONTEXT_ADAPTER_FEATURE,
  MAX_PASS_EXPLANATION_EDGES,
  MAX_PASS_EXPLANATION_ID_LENGTH,
  MAX_PASS_EXPLANATION_NESTED_ITEMS,
  MAX_PASS_EXPLANATION_NODES,
  PASS_EXPLANATION_QUESTION,
  PASS_EXPLANATION_SCHEMA_VERSION,
  PASS_SELECTION_DECISION_CAPABILITY,
  PASS_SELECTION_DECISION_SCHEMA_VERSION,
  PASS_SELECTION_RATIONALE_SCHEMA_VERSION,
  sourceNameMatchesUri,
  VARIANT_BUILD_EVIDENCE_CAPABILITY,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';

const MAX_TEXT_LENGTH = 16 * 1_024;
const MAX_URI_LENGTH = 16 * 1_024;

const NODE_KINDS = new Set([
  'source-pass',
  'material-context',
  'shader-context',
  'variant',
  'compiler',
  'generated-source',
]);

const ORDINARY_EDGE_KINDS = new Set([
  'context-variant',
  'context-compiler',
  'compiler-generated',
  'generated-source-map',
]);

const SHADER_STAGES = [
  'vertex',
  'fragment',
  'geometry',
  'hull',
  'domain',
  'surface',
  'kernel',
  'raytracing',
] as const;

const COMPILER_STALE_REASONS = [
  'source-changed',
  'source-deleted',
  'source-hash-mismatch',
  'adapter-disconnected',
  'adapter-reconnected',
  'superseded',
] as const;

export type PassExplanationGraphShapeValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'invalid-graph' | 'invalid-node' | 'invalid-edge';
      readonly detail: string;
    };

class ShapeFailure extends Error {}

/**
 * Validate the complete JSON shape before the explanation engine performs
 * graph joins. This function is bounded, deterministic, and performs no I/O.
 */
export function validatePassExplanationGraphShape(
  value: unknown,
): PassExplanationGraphShapeValidation {
  let graph: Record<string, unknown>;
  try {
    graph = expectRecord(value, 'graph');
    expectExactNumber(
      graph.schemaVersion,
      PASS_EXPLANATION_SCHEMA_VERSION,
      'graph.schemaVersion',
    );
    expectExact(
      graph.question,
      PASS_EXPLANATION_QUESTION,
      'graph.question',
    );
    expectId(graph.graphId, 'graph.graphId');
  } catch (error) {
    return invalid('invalid-graph', error);
  }

  if (!Array.isArray(graph.nodes)) {
    return {
      ok: false,
      code: 'invalid-graph',
      detail: 'graph.nodes must be an array.',
    };
  }
  if (!Array.isArray(graph.edges)) {
    return {
      ok: false,
      code: 'invalid-graph',
      detail: 'graph.edges must be an array.',
    };
  }
  if (graph.nodes.length > MAX_PASS_EXPLANATION_NODES) {
    return {
      ok: false,
      code: 'invalid-graph',
      detail: `graph.nodes exceeds ${MAX_PASS_EXPLANATION_NODES} items.`,
    };
  }
  if (graph.edges.length > MAX_PASS_EXPLANATION_EDGES) {
    return {
      ok: false,
      code: 'invalid-graph',
      detail: `graph.edges exceeds ${MAX_PASS_EXPLANATION_EDGES} items.`,
    };
  }

  for (const [index, node] of graph.nodes.entries()) {
    try {
      validateNode(node, `graph.nodes[${index}]`);
    } catch (error) {
      return invalid('invalid-node', error);
    }
  }
  for (const [index, edge] of graph.edges.entries()) {
    try {
      validateEdge(edge, `graph.edges[${index}]`);
    } catch (error) {
      return invalid('invalid-edge', error);
    }
  }
  return { ok: true };
}

function invalid(
  code: 'invalid-graph' | 'invalid-node' | 'invalid-edge',
  error: unknown,
): PassExplanationGraphShapeValidation {
  return {
    ok: false,
    code,
    detail: error instanceof Error ? error.message : 'unknown shape failure',
  };
}

function validateNode(value: unknown, path: string): void {
  const node = expectRecord(value, path);
  expectId(node.id, `${path}.id`);
  const kind = expectString(node.kind, `${path}.kind`);
  if (!NODE_KINDS.has(kind)) fail(`${path}.kind is unsupported.`);
  switch (kind) {
    case 'source-pass':
      validateSourceNode(node, path);
      return;
    case 'material-context':
      validateMaterialNode(node, path);
      return;
    case 'shader-context':
      validateContextNode(node, path);
      return;
    case 'variant':
      validateVariantNode(node, path);
      return;
    case 'compiler':
      validateCompilerNode(node, path);
      return;
    case 'generated-source':
      validateGeneratedNode(node, path);
  }
}

function validateSourceNode(node: Record<string, unknown>, path: string): void {
  validateSourceIdentity(node.source, `${path}.source`);
  validateShaderProgram(node.program, `${path}.program`);
  validateRange(node.range, `${path}.range`);
}

function validateMaterialNode(node: Record<string, unknown>, path: string): void {
  const context = expectRecord(node.context, `${path}.context`);
  const selectionId = expectId(
    context.selectionId,
    `${path}.context.selectionId`,
  );
  validateMaterialAsset(context.material, `${path}.context.material`);
  validateMaterialAsset(context.shader, `${path}.context.shader`);
  if (context.selectedProgram !== undefined) {
    validateProgramIdentity(
      context.selectedProgram,
      `${path}.context.selectedProgram`,
      false,
    );
  }
  const provenance = validateBasicProvenance(
    context.provenance,
    `${path}.context.provenance`,
    MATERIAL_CONTEXT_ADAPTER_FEATURE,
  );
  const sourceRevision = expectId(
    provenance.sourceRevision,
    `${path}.context.provenance.sourceRevision`,
  );
  if (sourceRevision !== selectionId) {
    fail(
      `${path}.context.provenance.sourceRevision must match context.selectionId.`,
    );
  }
}

function validateContextNode(node: Record<string, unknown>, path: string): void {
  const correlation = expectRecord(node.correlation, `${path}.correlation`);
  expectExact(correlation.status, 'current', `${path}.correlation.status`);
  const traceStatus = expectOneOf(
    correlation.traceStatus,
    ['verified-local-trace', 'sanitized-fixture'],
    `${path}.correlation.traceStatus`,
  );
  const evidence = expectRecord(
    correlation.evidence,
    `${path}.correlation.evidence`,
  );
  expectExactNumber(
    evidence.schemaVersion,
    1,
    `${path}.correlation.evidence.schemaVersion`,
  );
  const provenance = validateGpuProvenance(
    evidence.provenance,
    `${path}.correlation.evidence.provenance`,
  );
  const draw = validateCapturedDraw(
    evidence.draw,
    `${path}.correlation.evidence.draw`,
  );
  validateTraceVerification(
    correlation.traceVerification,
    `${path}.correlation.traceVerification`,
    traceStatus,
    draw,
  );
  const evidenceContext = validateCapturedContext(
    evidence.context,
    `${path}.correlation.evidence.context`,
  );
  const mapping = validateGpuMapping(
    evidence.mapping,
    `${path}.correlation.evidence.mapping`,
  );
  const uri = expectUri(correlation.uri, `${path}.correlation.uri`);
  const range = validateRange(correlation.range, `${path}.correlation.range`);
  const currentContext = validateCapturedContext(
    correlation.context,
    `${path}.correlation.context`,
  );
  if (!sameCapturedContext(currentContext, evidenceContext)) {
    fail(`${path}.correlation.context must exactly match evidence.context.`);
  }
  if (!sameRange(range, mapping.range)) {
    fail(`${path}.correlation.range must exactly match evidence.mapping.range.`);
  }
  if (
    mapping.expectedText !== evidenceContext.entryPoint
    || mapping.sourceEntryPoint !== evidenceContext.entryPoint
  ) {
    fail(
      `${path}.correlation.evidence.mapping expectedText and sourceEntryPoint must match evidence.context.entryPoint.`,
    );
  }
  if (!rangeMatchesExactText(range, mapping.expectedText)) {
    fail(
      `${path}.correlation.evidence.mapping.range must be one line and exactly span expectedText.`,
    );
  }
  if (
    uriKey(uri) !== uriKey(mapping.uri)
    || uriKey(uri) !== uriKey(provenance.sourceRevision.uri)
  ) {
    fail(`${path}.correlation.uri must match mapped and source-revision URIs.`);
  }
}

function validateVariantNode(node: Record<string, unknown>, path: string): void {
  const build = expectRecord(node.build, `${path}.build`);
  const status = expectOneOf(
    build.status,
    ['completed', 'incomplete', 'failed'],
    `${path}.build.status`,
  );
  const provenance = validateBasicProvenance(
    build.provenance,
    `${path}.build.provenance`,
    VARIANT_BUILD_EVIDENCE_CAPABILITY,
  );
  expectText(provenance.buildTarget, `${path}.build.provenance.buildTarget`);
  validateRevision(
    provenance.sourceRevision,
    `${path}.build.provenance.sourceRevision`,
  );
  if (status === 'completed' && build.failure !== undefined) {
    fail(`${path}.build completed build must not contain failure.`);
  }
  if (status === 'failed' && build.failure === undefined) {
    fail(`${path}.build failed build must contain failure.`);
  }
  if (build.failure !== undefined) {
    validateVariantFailure(build.failure, `${path}.build.failure`);
  }
  validateVariantContext(node.context, `${path}.context`);
}

function validateCompilerNode(node: Record<string, unknown>, path: string): void {
  const record = expectRecord(node.record, `${path}.record`);
  const status = expectOneOf(
    record.status,
    ['current', 'stale'],
    `${path}.record.status`,
  );
  const evidenceId = expectHash(
    record.evidenceId,
    `${path}.record.evidenceId`,
  );
  const sourceUri = expectUri(record.sourceUri, `${path}.record.sourceUri`);
  const contextId = expectId(record.contextId, `${path}.record.contextId`);
  const profile = validateCompileProfile(
    record.profile,
    `${path}.record.profile`,
  );
  const views = expectBoundedArray(record.views, `${path}.record.views`);
  if (views.length === 0) fail(`${path}.record.views must not be empty.`);
  const viewKinds = new Set<string>();
  for (const [index, value] of views.entries()) {
    const view = expectRecord(value, `${path}.record.views[${index}]`);
    const kind = expectOneOf(
      view.kind,
      ['preprocessed', 'generated'],
      `${path}.record.views[${index}].kind`,
    );
    if (viewKinds.has(kind)) {
      fail(`${path}.record.views repeats ${kind}.`);
    }
    viewKinds.add(kind);
    const uri = expectUri(view.uri, `${path}.record.views[${index}].uri`);
    if (uri !== compilerViewUri(evidenceId, kind)) {
      fail(`${path}.record.views[${index}].uri must bind record.evidenceId.`);
    }
    expectHash(
      view.contentHash,
      `${path}.record.views[${index}].contentHash`,
    );
  }
  const provenance = validateCompilerProvenance(
    record.provenance,
    `${path}.record.provenance`,
  );
  if (contextId !== provenance.contextId) {
    fail(`${path}.record.contextId must match record.provenance.contextId.`);
  }
  if (!sameProfile(profile, provenance.profile)) {
    fail(`${path}.record.profile must match record.provenance.profile.`);
  }
  if (uriKey(sourceUri) !== uriKey(provenance.sourceRevision.uri)) {
    fail(`${path}.record.sourceUri must match record.provenance.sourceRevision.uri.`);
  }
  if (status === 'current' && record.reason !== undefined) {
    fail(`${path}.record current record must not contain a stale reason.`);
  }
  if (status === 'stale') {
    expectOneOf(
      record.reason,
      COMPILER_STALE_REASONS,
      `${path}.record.reason`,
    );
  }
}

function validateGeneratedNode(node: Record<string, unknown>, path: string): void {
  const evidenceId = expectHash(node.evidenceId, `${path}.evidenceId`);
  const view = expectRecord(node.view, `${path}.view`);
  expectExact(view.kind, 'generated', `${path}.view.kind`);
  const viewUri = expectUri(view.uri, `${path}.view.uri`);
  if (viewUri !== compilerViewUri(evidenceId, 'generated')) {
    fail(`${path}.view.uri must bind the generated evidenceId.`);
  }
  const document = expectRecord(node.document, `${path}.document`);
  expectHash(document.contentHash, `${path}.document.contentHash`);
  const documentRange = validateRange(
    document.range,
    `${path}.document.range`,
  );
  const mapping = validateCompilerMapping(node.mapping, `${path}.mapping`);
  if (!sameRange(documentRange, mapping.generatedRange)) {
    fail(`${path}.document.range must match mapping.generatedRange.`);
  }
}

function validateEdge(value: unknown, path: string): void {
  const edge = expectRecord(value, path);
  expectId(edge.id, `${path}.id`);
  const kind = expectString(edge.kind, `${path}.kind`);
  if (kind === 'selection-decision') {
    validateSelectionDecisionEdge(edge, path);
    return;
  }
  if (!ORDINARY_EDGE_KINDS.has(kind)) {
    fail(`${path}.kind is unsupported.`);
  }
  expectId(edge.fromNodeId, `${path}.fromNodeId`);
  expectId(edge.toNodeId, `${path}.toNodeId`);
}

function validateSelectionDecisionEdge(
  edge: Record<string, unknown>,
  path: string,
): void {
  expectId(edge.materialNodeId, `${path}.materialNodeId`);
  expectId(edge.contextNodeId, `${path}.contextNodeId`);
  expectId(edge.sourceNodeId, `${path}.sourceNodeId`);
  expectExact(
    edge.reason,
    'adapter-reported-material-pass-selection',
    `${path}.reason`,
  );
  const decision = expectRecord(edge.decision, `${path}.decision`);
  expectExactNumber(
    decision.schemaVersion,
    PASS_SELECTION_DECISION_SCHEMA_VERSION,
    `${path}.decision.schemaVersion`,
  );
  expectId(decision.decisionId, `${path}.decision.decisionId`);
  expectId(decision.selectionId, `${path}.decision.selectionId`);
  validateProgramIdentity(
    decision.program,
    `${path}.decision.program`,
    true,
  );
  validateRevision(
    decision.materialRevision,
    `${path}.decision.materialRevision`,
  );
  validateRevision(
    decision.shaderRevision,
    `${path}.decision.shaderRevision`,
  );
  expectId(decision.contextId, `${path}.decision.contextId`);
  validateSelectionRationale(
    decision.rationale,
    `${path}.decision.rationale`,
  );
  validateBasicProvenance(
    decision.provenance,
    `${path}.decision.provenance`,
    PASS_SELECTION_DECISION_CAPABILITY,
  );
}

function validateSelectionRationale(value: unknown, path: string): void {
  const rationale = expectRecord(value, path);
  expectExactNumber(
    rationale.schemaVersion,
    PASS_SELECTION_RATIONALE_SCHEMA_VERSION,
    `${path}.schemaVersion`,
  );
  expectId(rationale.ruleId, `${path}.ruleId`);
  expectText(rationale.summary, `${path}.summary`);
  const facts = expectBoundedArray(rationale.facts, `${path}.facts`);
  if (facts.length === 0) fail(`${path}.facts must not be empty.`);
  const names = new Set<string>();
  for (const [index, value] of facts.entries()) {
    const fact = expectRecord(value, `${path}.facts[${index}]`);
    const name = expectText(fact.name, `${path}.facts[${index}].name`);
    expectText(fact.value, `${path}.facts[${index}].value`);
    if (names.has(name)) fail(`${path}.facts repeats "${name}".`);
    names.add(name);
  }
}

function validateShaderProgram(value: unknown, path: string): void {
  const program = expectRecord(value, path);
  expectNonNegativeInteger(program.blockIndex, `${path}.blockIndex`);
  expectText(program.shaderName, `${path}.shaderName`);
  validateProgramIdentity(program, path, true);
  const stages = expectBoundedArray(program.stages, `${path}.stages`);
  for (const [index, value] of stages.entries()) {
    const stage = expectRecord(value, `${path}.stages[${index}]`);
    expectOneOf(stage.stage, SHADER_STAGES, `${path}.stages[${index}].stage`);
    expectText(stage.entryPoint, `${path}.stages[${index}].entryPoint`);
    validateUniqueTextArray(
      stage.defines,
      `${path}.stages[${index}].defines`,
    );
  }
  const sharedBlocks = expectBoundedArray(
    program.sharedBlockIndices,
    `${path}.sharedBlockIndices`,
  );
  const seen = new Set<number>();
  for (const [index, value] of sharedBlocks.entries()) {
    const block = expectNonNegativeInteger(
      value,
      `${path}.sharedBlockIndices[${index}]`,
    );
    if (seen.has(block)) fail(`${path}.sharedBlockIndices repeats ${block}.`);
    seen.add(block);
  }
}

function validateProgramIdentity(
  value: unknown,
  path: string,
  requirePass: boolean,
): Record<string, unknown> {
  const program = expectRecord(value, path);
  expectNonNegativeInteger(program.subShaderIndex, `${path}.subShaderIndex`);
  if (program.passIndex !== undefined) {
    expectNonNegativeInteger(program.passIndex, `${path}.passIndex`);
  }
  if (program.passName !== undefined) {
    expectText(program.passName, `${path}.passName`);
  }
  if (
    requirePass
    && program.passIndex === undefined
    && program.passName === undefined
  ) {
    fail(`${path} must identify a Pass.`);
  }
  return program;
}

function validateMaterialAsset(value: unknown, path: string): void {
  const asset = expectRecord(value, path);
  expectText(asset.name, `${path}.name`);
  expectText(asset.path, `${path}.path`);
  validateRevision(asset.revision, `${path}.revision`);
}

function validateGpuProvenance(
  value: unknown,
  path: string,
): Record<string, unknown> & {
  readonly sourceRevision: {
    readonly uri: string;
    readonly assetGuid: string;
    readonly contentHash: string;
  };
} {
  const provenance = validateBasicProvenance(
    value,
    path,
    GPU_CAPTURE_CORRELATION_CAPABILITY,
  );
  expectText(provenance.unityBinaryVersion, `${path}.unityBinaryVersion`);
  const platform = expectRecord(provenance.platform, `${path}.platform`);
  expectExact(platform.operatingSystem, 'macOS', `${path}.platform.operatingSystem`);
  expectText(platform.operatingSystemVersion, `${path}.platform.operatingSystemVersion`);
  expectExact(platform.architecture, 'arm64', `${path}.platform.architecture`);
  const gpu = expectRecord(provenance.gpu, `${path}.gpu`);
  expectText(gpu.name, `${path}.gpu.name`);
  expectText(gpu.driverVersion, `${path}.gpu.driverVersion`);
  if (gpu.registryId !== undefined) {
    expectText(gpu.registryId, `${path}.gpu.registryId`);
  }
  expectExact(provenance.graphicsApi, 'Metal', `${path}.graphicsApi`);
  const tool = expectRecord(provenance.tool, `${path}.tool`);
  expectExact(tool.name, 'Xcode Metal Frame Debugger', `${path}.tool.name`);
  expectText(tool.version, `${path}.tool.version`);
  expectText(tool.buildVersion, `${path}.tool.buildVersion`);
  expectText(tool.metalCompilerVersion, `${path}.tool.metalCompilerVersion`);
  expectExact(tool.traceFormat, 'gputrace', `${path}.tool.traceFormat`);
  const sourceRevision = validateRevision(
    provenance.sourceRevision,
    `${path}.sourceRevision`,
  );
  return { ...provenance, sourceRevision };
}

function validateCapturedDraw(
  value: unknown,
  path: string,
): {
  readonly label: string;
  readonly trace: {
    readonly fileName: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
} {
  const draw = expectRecord(value, path);
  expectId(draw.captureId, `${path}.captureId`);
  expectNonNegativeInteger(draw.frameIndex, `${path}.frameIndex`);
  expectNonNegativeInteger(draw.drawIndex, `${path}.drawIndex`);
  const label = expectText(draw.label, `${path}.label`);
  const trace = expectRecord(draw.trace, `${path}.trace`);
  expectExact(trace.storage, 'local-ephemeral', `${path}.trace.storage`);
  const fileName = expectTraceFileName(
    trace.fileName,
    `${path}.trace.fileName`,
  );
  const sha256 = expectHash(trace.sha256, `${path}.trace.sha256`);
  const byteLength = expectPositiveSafeInteger(
    trace.byteLength,
    `${path}.trace.byteLength`,
  );
  return {
    label,
    trace: { fileName, sha256, byteLength },
  };
}

function validateTraceVerification(
  value: unknown,
  path: string,
  traceStatus: string,
  draw: {
    readonly label: string;
    readonly trace: {
      readonly fileName: string;
      readonly sha256: string;
      readonly byteLength: number;
    };
  },
): void {
  const verification = expectRecord(value, path);
  const status = expectOneOf(
    verification.status,
    ['verified-local-trace', 'sanitized-fixture'],
    `${path}.status`,
  );
  if (status !== traceStatus) {
    fail(`${path}.status must match correlation.traceStatus.`);
  }
  if (status === 'sanitized-fixture') return;

  const fileName = expectTraceFileName(
    verification.fileName,
    `${path}.fileName`,
  );
  const sha256 = expectHash(verification.sha256, `${path}.sha256`);
  const byteLength = expectPositiveSafeInteger(
    verification.byteLength,
    `${path}.byteLength`,
  );
  const labels = validateUniqueTextArray(
    verification.labels,
    `${path}.labels`,
  );
  if (
    fileName !== draw.trace.fileName
    || sha256 !== draw.trace.sha256
    || byteLength !== draw.trace.byteLength
  ) {
    fail(`${path} must exactly match the captured draw trace identity.`);
  }
  if (!labels.includes(draw.label)) {
    fail(`${path}.labels must contain the captured draw label.`);
  }
}

function validateCapturedContext(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const context = expectRecord(value, path);
  expectId(context.id, `${path}.id`);
  expectText(context.shaderName, `${path}.shaderName`);
  expectNonNegativeInteger(
    context.subShaderIndex,
    `${path}.subShaderIndex`,
  );
  expectNonNegativeInteger(context.passIndex, `${path}.passIndex`);
  if (context.passName !== undefined) {
    expectText(context.passName, `${path}.passName`);
  }
  expectOneOf(context.stage, SHADER_STAGES, `${path}.stage`);
  expectText(context.entryPoint, `${path}.entryPoint`);
  const keywords = expectRecord(context.keywords, `${path}.keywords`);
  validateUniqueTextArray(keywords.enabled, `${path}.keywords.enabled`);
  expectBoolean(keywords.incomplete, `${path}.keywords.incomplete`);
  return context;
}

function validateGpuMapping(
  value: unknown,
  path: string,
): {
  readonly uri: string;
  readonly range: ValidRange;
  readonly expectedText: string;
  readonly sourceEntryPoint: string;
} {
  const mapping = expectRecord(value, path);
  expectExact(mapping.status, 'mapped', `${path}.status`);
  expectExact(
    mapping.method,
    'adapter-exact-source-range',
    `${path}.method`,
  );
  const uri = expectUri(mapping.uri, `${path}.uri`);
  const range = validateRange(mapping.range, `${path}.range`);
  const expectedText = expectText(
    mapping.expectedText,
    `${path}.expectedText`,
  );
  const sourceEntryPoint = expectText(
    mapping.sourceEntryPoint,
    `${path}.sourceEntryPoint`,
  );
  return { uri, range, expectedText, sourceEntryPoint };
}

function validateVariantFailure(value: unknown, path: string): void {
  const failure = expectRecord(value, path);
  expectOneOf(
    failure.phase,
    ['compilation', 'stripping', 'build'],
    `${path}.phase`,
  );
  expectText(failure.message, `${path}.message`);
}

function validateVariantContext(value: unknown, path: string): void {
  const context = expectRecord(value, path);
  expectText(context.shaderName, `${path}.shaderName`);
  validateProgramIdentity(context, path, false);
  expectOneOf(context.stage, SHADER_STAGES, `${path}.stage`);
  expectText(context.graphicsApi, `${path}.graphicsApi`);
  validateMeasuredCount(context.compileCandidates, `${path}.compileCandidates`);
  validateMeasuredCount(context.kept, `${path}.kept`);
  const keywordSets = expectBoundedArray(
    context.keywordSets,
    `${path}.keywordSets`,
  );
  for (const [index, value] of keywordSets.entries()) {
    const keywordSet = expectRecord(
      value,
      `${path}.keywordSets[${index}]`,
    );
    validateUniqueTextArray(
      keywordSet.keywords,
      `${path}.keywordSets[${index}].keywords`,
    );
    expectOneOf(
      keywordSet.scope,
      ['global', 'local'],
      `${path}.keywordSets[${index}].scope`,
    );
    if (keywordSet.stage !== undefined) {
      expectOneOf(
        keywordSet.stage,
        SHADER_STAGES,
        `${path}.keywordSets[${index}].stage`,
      );
    }
    expectBoolean(
      keywordSet.hasBlankOption,
      `${path}.keywordSets[${index}].hasBlankOption`,
    );
    validateMeasuredCount(
      keywordSet.compileCandidates,
      `${path}.keywordSets[${index}].compileCandidates`,
    );
    validateMeasuredCount(
      keywordSet.kept,
      `${path}.keywordSets[${index}].kept`,
    );
  }
}

function validateMeasuredCount(value: unknown, path: string): void {
  const count = expectRecord(value, path);
  const availability = expectOneOf(
    count.availability,
    ['available', 'unavailable'],
    `${path}.availability`,
  );
  if (availability === 'available') {
    const digits = expectString(count.count, `${path}.count`);
    if (!/^(?:0|[1-9][0-9]*)$/.test(digits)) {
      fail(`${path}.count must be a non-negative base-10 integer.`);
    }
    if (count.reason !== undefined) {
      fail(`${path} available count must not contain a reason.`);
    }
  } else {
    expectOneOf(
      count.reason,
      ['not-collected', 'build-failed', 'unsupported'],
      `${path}.reason`,
    );
    if (count.count !== undefined) {
      fail(`${path} unavailable count must not contain a count.`);
    }
  }
}

function validateCompilerProvenance(
  value: unknown,
  path: string,
): Record<string, unknown> & {
  readonly sourceRevision: {
    readonly uri: string;
    readonly assetGuid: string;
    readonly contentHash: string;
  };
  readonly contextId: string;
  readonly profile: Record<string, unknown>;
} {
  const provenance = validateBasicProvenance(
    value,
    path,
    COMPILER_EVIDENCE_CAPABILITY,
  );
  const sourceRevision = validateRevision(
    provenance.sourceRevision,
    `${path}.sourceRevision`,
  );
  const contextId = expectId(provenance.contextId, `${path}.contextId`);
  const profile = validateCompileProfile(
    provenance.profile,
    `${path}.profile`,
  );
  return {
    ...provenance,
    sourceRevision,
    contextId,
    profile,
  };
}

function validateCompileProfile(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const profile = expectRecord(value, path);
  expectText(profile.name, `${path}.name`);
  expectText(profile.platform, `${path}.platform`);
  expectText(profile.graphicsApi, `${path}.graphicsApi`);
  expectText(profile.capability, `${path}.capability`);
  return profile;
}

function validateCompilerMapping(
  value: unknown,
  path: string,
): { readonly generatedRange: ValidRange } {
  const mapping = expectRecord(value, path);
  const uri = expectUri(mapping.uri, `${path}.uri`);
  const sourceRange = validateRange(mapping.range, `${path}.range`);
  const generatedRange = validateRange(
    mapping.generatedRange,
    `${path}.generatedRange`,
  );
  if (
    sourceRange.start.line !== sourceRange.end.line
    || generatedRange.start.line !== generatedRange.end.line
  ) {
    fail(`${path} must identify one exact generated/source line pair.`);
  }
  const sourceIdentity = validateSourceIdentity(
    mapping.sourceIdentity,
    `${path}.sourceIdentity`,
  );
  if (uriKey(uri) !== uriKey(sourceIdentity.uri)) {
    fail(`${path}.uri must match mapping.sourceIdentity.uri.`);
  }
  const provenance = expectRecord(mapping.provenance, `${path}.provenance`);
  expectExact(
    provenance.method,
    'line-directive',
    `${path}.provenance.method`,
  );
  expectExact(
    provenance.granularity,
    'line',
    `${path}.provenance.granularity`,
  );
  validateCompilerProvenance(
    provenance.evidence,
    `${path}.provenance.evidence`,
  );
  const directive = validateCompilerDirective(
    provenance.directive,
    `${path}.provenance.directive`,
  );
  if (
    directive.documentLine >= generatedRange.start.line
    || directive.sourceLine !== sourceRange.start.line
    || generatedRange.start.character !== sourceRange.start.character
    || generatedRange.end.character !== sourceRange.end.character
    || !sourceNameMatchesUri(uri, directive.sourceName)
  ) {
    fail(
      `${path}.provenance.directive must precede and identify the exact generated/source line pair.`,
    );
  }
  return { generatedRange };
}

function validateCompilerDirective(
  value: unknown,
  path: string,
): {
  readonly documentLine: number;
  readonly sourceLine: number;
  readonly sourceName: string;
} {
  const directive = expectRecord(value, path);
  const documentLine = expectNonNegativeInteger(
    directive.documentLine,
    `${path}.documentLine`,
  );
  const sourceLine = expectNonNegativeInteger(
    directive.sourceLine,
    `${path}.sourceLine`,
  );
  const sourceName = expectText(directive.sourceName, `${path}.sourceName`);
  return { documentLine, sourceLine, sourceName };
}

function validateSourceIdentity(
  value: unknown,
  path: string,
): {
  readonly uri: string;
  readonly sourceId: string;
  readonly contentHash: string;
} {
  const source = expectRecord(value, path);
  const uri = expectUri(source.uri, `${path}.uri`);
  const sourceId = expectText(source.sourceId, `${path}.sourceId`);
  const contentHash = expectHash(source.contentHash, `${path}.contentHash`);
  return { uri, sourceId, contentHash };
}

function validateRevision(
  value: unknown,
  path: string,
): {
  readonly uri: string;
  readonly assetGuid: string;
  readonly contentHash: string;
} {
  const revision = expectRecord(value, path);
  const uri = expectUri(revision.uri, `${path}.uri`);
  const assetGuid = expectGuid(revision.assetGuid, `${path}.assetGuid`);
  const contentHash = expectHash(
    revision.contentHash,
    `${path}.contentHash`,
  );
  return { uri, assetGuid, contentHash };
}

function validateBasicProvenance(
  value: unknown,
  path: string,
  capability: string,
): Record<string, unknown> {
  const provenance = expectRecord(value, path);
  expectExact(provenance.capability, capability, `${path}.capability`);
  expectId(provenance.projectId, `${path}.projectId`);
  expectId(provenance.instanceId, `${path}.instanceId`);
  expectText(provenance.adapterVersion, `${path}.adapterVersion`);
  expectText(provenance.unityVersion, `${path}.unityVersion`);
  const collectedAt = expectPositiveFiniteNumber(
    provenance.collectedAt,
    `${path}.collectedAt`,
  );
  if (!Number.isFinite(new Date(collectedAt).getTime())) {
    fail(`${path}.collectedAt must be a valid epoch millisecond.`);
  }
  return provenance;
}

interface ValidRange {
  readonly start: ValidPosition;
  readonly end: ValidPosition;
}

interface ValidPosition {
  readonly line: number;
  readonly character: number;
}

function validateRange(value: unknown, path: string): ValidRange {
  const range = expectRecord(value, path);
  const start = validatePosition(range.start, `${path}.start`);
  const end = validatePosition(range.end, `${path}.end`);
  if (!positionAtOrBefore(start, end)) {
    fail(`${path} must have start at or before end.`);
  }
  return { start, end };
}

function validatePosition(value: unknown, path: string): ValidPosition {
  const position = expectRecord(value, path);
  return {
    line: expectNonNegativeInteger(position.line, `${path}.line`),
    character: expectNonNegativeInteger(
      position.character,
      `${path}.character`,
    ),
  };
}

function sameRange(left: ValidRange, right: ValidRange): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function rangeMatchesExactText(range: ValidRange, text: string): boolean {
  return range.start.line === range.end.line
    && range.end.character - range.start.character === text.length;
}

function sameCapturedContext(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeywords = left.keywords as {
    readonly enabled: readonly string[];
    readonly incomplete: boolean;
  };
  const rightKeywords = right.keywords as typeof leftKeywords;
  return left.id === right.id
    && left.shaderName === right.shaderName
    && left.subShaderIndex === right.subShaderIndex
    && left.passIndex === right.passIndex
    && left.passName === right.passName
    && left.stage === right.stage
    && left.entryPoint === right.entryPoint
    && leftKeywords.incomplete === rightKeywords.incomplete
    && leftKeywords.enabled.length === rightKeywords.enabled.length
    && leftKeywords.enabled.every((keyword, index) => (
      keyword === rightKeywords.enabled[index]
    ));
}

function sameProfile(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return left.name === right.name
    && left.platform === right.platform
    && left.graphicsApi === right.graphicsApi
    && left.capability === right.capability;
}

function compilerViewUri(evidenceId: string, kind: string): string {
  return `unity-shader-nav-compiler://evidence/${evidenceId}/${kind}.hlsl`;
}

function expectBoundedArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`);
  if (value.length > MAX_PASS_EXPLANATION_NESTED_ITEMS) {
    fail(`${path} exceeds ${MAX_PASS_EXPLANATION_NESTED_ITEMS} items.`);
  }
  return value;
}

function validateUniqueTextArray(value: unknown, path: string): string[] {
  const array = expectBoundedArray(value, path);
  const result: string[] = [];
  const unique = new Set<string>();
  for (const [index, item] of array.entries()) {
    const text = expectText(item, `${path}[${index}]`);
    if (unique.has(text)) fail(`${path} repeats "${text}".`);
    unique.add(text);
    result.push(text);
  }
  return result;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(`${path} must be a string.`);
  return value;
}

function expectText(value: unknown, path: string): string {
  const text = expectString(value, path);
  if (text.trim().length === 0 || text.length > MAX_TEXT_LENGTH) {
    fail(`${path} must be non-empty and bounded.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    fail(`${path} must not contain control characters.`);
  }
  return text;
}

function expectId(value: unknown, path: string): string {
  const id = expectString(value, path);
  if (
    id.trim().length === 0
    || id.length > MAX_PASS_EXPLANATION_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(id)
  ) {
    fail(`${path} must be a bounded printable identifier.`);
  }
  return id;
}

function expectUri(value: unknown, path: string): string {
  const uri = expectString(value, path);
  if (
    uri.length === 0
    || uri.length > MAX_URI_LENGTH
    || /[\u0000-\u001f\u007f]/.test(uri)
    || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)
  ) {
    fail(`${path} must be a bounded absolute URI.`);
  }
  try {
    new URL(uri);
  } catch {
    fail(`${path} must be a valid absolute URI.`);
  }
  return uri;
}

function expectHash(value: unknown, path: string): string {
  const hash = expectString(value, path);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    fail(`${path} must be a lowercase SHA-256 digest.`);
  }
  return hash;
}

function expectGuid(value: unknown, path: string): string {
  const guid = expectString(value, path);
  if (!/^[a-f0-9]{32}$/.test(guid)) {
    fail(`${path} must be a lowercase 32-hex asset GUID.`);
  }
  return guid;
}

function expectTraceFileName(value: unknown, path: string): string {
  const fileName = expectText(value, path);
  if (
    fileName === '.'
    || fileName === '..'
    || fileName.includes('/')
    || fileName.includes('\\')
    || !fileName.endsWith('.gputrace')
  ) {
    fail(`${path} must be a local .gputrace basename without path traversal.`);
  }
  return fileName;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean.`);
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}

function expectPositiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${path} must be a positive safe integer.`);
  }
  return value as number;
}

function expectPositiveFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${path} must be a positive finite number.`);
  }
  return value;
}

function expectExact(value: unknown, expected: string, path: string): void {
  if (value !== expected) fail(`${path} must be "${expected}".`);
}

function expectExactNumber(
  value: unknown,
  expected: number,
  path: string,
): void {
  if (value !== expected) fail(`${path} must be ${expected}.`);
}

function expectOneOf(
  value: unknown,
  expected: readonly string[],
  path: string,
): string {
  const text = expectString(value, path);
  if (!expected.includes(text)) {
    fail(`${path} must be one of ${expected.join(', ')}.`);
  }
  return text;
}

function positionAtOrBefore(
  left: ValidPosition,
  right: ValidPosition,
): boolean {
  return left.line < right.line
    || (left.line === right.line && left.character <= right.character);
}

function fail(message: string): never {
  throw new ShapeFailure(message);
}
