import {
  MAX_PASS_EXPLANATION_EDGES,
  MAX_PASS_EXPLANATION_ANSWER_BYTES,
  MAX_PASS_EXPLANATION_DISCLOSURES,
  MAX_PASS_EXPLANATION_ID_LENGTH,
  MAX_PASS_EXPLANATION_NODES,
  MAX_PASS_EXPLANATION_PAYLOAD_BYTES,
  PASS_EXPLANATION_QUESTION,
  PASS_EXPLANATION_SCHEMA_VERSION,
  type AdapterSourceRevision,
  type CompilerEvidenceProvenance,
  type CompilerSourceIdentity,
  type MaterialContextProgram,
  type PassCausalExplanation,
  type PassExplanationAnswer,
  type PassExplanationCitation,
  type PassExplanationCompilerNode,
  type PassExplanationContextNode,
  type PassExplanationContradiction,
  type PassExplanationContradictionCode,
  type PassExplanationEvidenceEdge,
  type PassExplanationEvidenceGraph,
  type PassExplanationEvidenceNode,
  type PassExplanationEvidenceRequirement,
  type PassExplanationGeneratedNode,
  type PassExplanationMaterialNode,
  type PassExplanationMissingEvidence,
  type PassExplanationSourceNode,
  type PassExplanationVariantNode,
  type PassSelectionDecisionEdge,
  type PassSelectionObservation,
  type Range,
  sourceNameMatchesUri,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import { validatePassExplanationGraphShape } from './passExplanationGraphValidation';
const INVALID_CODES = new Set<PassExplanationContradictionCode>([
  'invalid-graph',
  'payload-limit-exceeded',
  'node-limit-exceeded',
  'edge-limit-exceeded',
  'invalid-node',
  'invalid-edge',
]);
const CITATION_ORDER = new Map<PassExplanationCitation['kind'], number>([
  ['source-pass', 0],
  ['material-context', 1],
  ['shader-context', 2],
  ['variant', 3],
  ['compiler', 4],
  ['generated-source', 5],
]);
const MISSING_ORDER = new Map<PassExplanationEvidenceRequirement, number>([
  ['material-context', 0],
  ['selected-program', 1],
  ['source-pass', 2],
  ['shader-context', 3],
  ['selection-decision', 4],
  ['variant', 5],
  ['context-variant-link', 6],
  ['compiler', 7],
  ['context-compiler-link', 8],
  ['generated-source', 9],
  ['compiler-generated-link', 10],
  ['generated-source-map-link', 11],
]);

interface Evaluation {
  readonly graph: PassExplanationEvidenceGraph;
  readonly nodes: readonly PassExplanationEvidenceNode[];
  readonly edges: readonly PassExplanationEvidenceEdge[];
  readonly nodeById: ReadonlyMap<string, PassExplanationEvidenceNode>;
  readonly material?: PassExplanationMaterialNode;
  readonly source?: PassExplanationSourceNode;
  readonly context?: PassExplanationContextNode;
  readonly decision?: PassSelectionDecisionEdge;
  readonly missing: PassExplanationMissingEvidence[];
  readonly contradictions: PassExplanationContradiction[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_PASS_EXPLANATION_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareGraphItems(
  left: { readonly id: string; readonly kind: string },
  right: { readonly id: string; readonly kind: string },
): number {
  return ordinalCompare(left.id, right.id)
    || ordinalCompare(left.kind, right.kind)
    || ordinalCompare(JSON.stringify(left), JSON.stringify(right));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function executionPolicy(): PassExplanationAnswer['execution'] {
  return {
    authority: 'deterministic-local-evidence-engine',
    locality: 'local-only',
    model: 'not-used',
    telemetry: 'none',
    retention: 'session-only',
  };
}

function safeGraphId(value: unknown): string {
  if (!record(value) || !validId(value.graphId)) return 'invalid-graph';
  return value.graphId;
}

function invalidAnswer(
  graphId: string,
  code: PassExplanationContradictionCode,
  detail: string,
): PassExplanationAnswer {
  // An engine defect is not a statement about the project's evidence, so it must
  // not be phrased as one.
  const internal = code === 'internal-error';
  return {
    schemaVersion: PASS_EXPLANATION_SCHEMA_VERSION,
    question: PASS_EXPLANATION_QUESTION,
    graphId,
    observation: {
      status: 'not-observed',
      reason: 'material-context-missing',
      statement: internal
        ? 'No Pass selection is reported because UnityShaderNav failed to evaluate this evidence.'
        : 'No Pass selection is reported because the evidence graph is invalid.',
      citationNodeIds: [],
    },
    causalExplanation: {
      status: 'refused',
      reason: 'invalid-evidence',
      statement: internal
        ? 'No causal explanation is claimed because UnityShaderNav failed to evaluate this evidence.'
        : 'No causal explanation is claimed from invalid or unbounded evidence.',
      citationNodeIds: [],
    },
    disclosures: {
      missing: [],
      contradictions: [{
        code,
        detail,
        nodeIds: [],
        edgeIds: [],
      }],
    },
    citations: [],
    suggestedEdits: [],
    execution: executionPolicy(),
  };
}

function topLevelGraph(value: unknown): value is {
  readonly schemaVersion: unknown;
  readonly question: unknown;
  readonly graphId: unknown;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
} {
  return record(value)
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges);
}

/**
 * Deterministically answer the one supported question from a bounded graph.
 * This function performs no I/O and owns no persistence, model, or telemetry
 * integration.
 */
export function explainPassSelection(
  input: unknown,
  onInternalError?: (error: unknown) => void,
): PassExplanationAnswer {
  const graphId = safeGraphId(input);
  if (!topLevelGraph(input)) {
    return invalidAnswer(graphId, 'invalid-graph', 'nodes and edges must be arrays');
  }
  if (input.nodes.length > MAX_PASS_EXPLANATION_NODES) {
    return invalidAnswer(
      graphId,
      'node-limit-exceeded',
      `node count ${input.nodes.length} exceeds ${MAX_PASS_EXPLANATION_NODES}`,
    );
  }
  if (input.edges.length > MAX_PASS_EXPLANATION_EDGES) {
    return invalidAnswer(
      graphId,
      'edge-limit-exceeded',
      `edge count ${input.edges.length} exceeds ${MAX_PASS_EXPLANATION_EDGES}`,
    );
  }

  let serialized: string;
  try {
    const encoded = JSON.stringify(input);
    if (encoded === undefined) {
      return invalidAnswer(graphId, 'invalid-graph', 'graph is not JSON serializable');
    }
    serialized = encoded;
  } catch {
    return invalidAnswer(graphId, 'invalid-graph', 'graph is not JSON serializable');
  }
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes > MAX_PASS_EXPLANATION_PAYLOAD_BYTES) {
    return invalidAnswer(
      graphId,
      'payload-limit-exceeded',
      `payload size ${payloadBytes} exceeds ${MAX_PASS_EXPLANATION_PAYLOAD_BYTES} bytes`,
    );
  }
  if (
    input.schemaVersion !== PASS_EXPLANATION_SCHEMA_VERSION
    || input.question !== PASS_EXPLANATION_QUESTION
    || !validId(input.graphId)
  ) {
    return invalidAnswer(
      graphId,
      'invalid-graph',
      'schemaVersion, question, or graphId is invalid',
    );
  }
  const shape = validatePassExplanationGraphShape(input);
  if (!shape.ok) {
    return invalidAnswer(graphId, shape.code, shape.detail);
  }

  try {
    const answer = evaluateGraph(input as PassExplanationEvidenceGraph);
    const answerBytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
    if (answerBytes > MAX_PASS_EXPLANATION_ANSWER_BYTES) {
      return invalidAnswer(
        graphId,
        'payload-limit-exceeded',
        `answer size ${answerBytes} exceeds ${MAX_PASS_EXPLANATION_ANSWER_BYTES} bytes`,
      );
    }
    return answer;
  } catch (error) {
    // The graph already passed shape validation above and this module throws
    // nothing itself, so anything caught here is a defect in this engine, not
    // bad project data. Report it as such and hand the caller the error so it
    // leaves a trace instead of telling the user to fix their Unity evidence.
    onInternalError?.(error);
    return invalidAnswer(
      graphId,
      'internal-error',
      'the local explanation engine failed to evaluate this evidence',
    );
  }
}

function evaluateGraph(graph: PassExplanationEvidenceGraph): PassExplanationAnswer {
  const nodes = [...graph.nodes].sort(compareGraphItems);
  const edges = [...graph.edges].sort(compareGraphItems);
  const missing: PassExplanationMissingEvidence[] = [];
  const contradictions: PassExplanationContradiction[] = [];
  const nodeById = new Map<string, PassExplanationEvidenceNode>();
  const edgeIds = new Set<string>();

  for (const node of nodes) {
    if (nodeById.has(node.id)) {
      addContradiction(contradictions, {
        code: 'duplicate-node-id',
        detail: `Evidence node id '${node.id}' is not unique.`,
        nodeIds: [node.id],
        edgeIds: [],
      });
    } else {
      nodeById.set(node.id, node);
    }
  }
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      addContradiction(contradictions, {
        code: 'duplicate-edge-id',
        detail: `Evidence edge id '${edge.id}' is not unique.`,
        nodeIds: [],
        edgeIds: [edge.id],
      });
    } else {
      edgeIds.add(edge.id);
    }
  }

  const materials = nodesOfKind(nodes, 'material-context');
  const sources = nodesOfKind(nodes, 'source-pass');
  const contexts = nodesOfKind(nodes, 'shader-context');
  const decisions = edgesOfKind(edges, 'selection-decision');

  if (materials.length === 0) {
    addMissing(missing, 'material-context', true, 'Current Material Context evidence is absent.');
  } else if (materials.length > 1) {
    addContradiction(contradictions, {
      code: 'multiple-primary-evidence',
      detail: 'More than one current Material Context is present.',
      nodeIds: materials.map(({ id }) => id),
      edgeIds: [],
    });
  }
  if (sources.length === 0) {
    addMissing(missing, 'source-pass', true, 'Exact source Pass evidence is absent.');
  } else if (sources.length > 1) {
    addContradiction(contradictions, {
      code: 'multiple-primary-evidence',
      detail: 'More than one exact source Pass is present.',
      nodeIds: sources.map(({ id }) => id),
      edgeIds: [],
    });
  }
  if (contexts.length === 0) {
    addMissing(missing, 'shader-context', true, 'Exact Shader Context evidence is absent.');
  } else if (contexts.length > 1) {
    addContradiction(contradictions, {
      code: 'multiple-primary-evidence',
      detail: 'More than one current Shader Context is present.',
      nodeIds: contexts.map(({ id }) => id),
      edgeIds: [],
    });
  }
  if (decisions.length === 0) {
    addMissing(
      missing,
      'selection-decision',
      true,
      'No authoritative Adapter selection-decision edge is present.',
    );
  } else if (decisions.length > 1) {
    addContradiction(contradictions, {
      code: 'multiple-selection-decisions',
      detail: 'More than one authoritative Pass selection decision is present.',
      nodeIds: [],
      edgeIds: decisions.map(({ id }) => id),
    });
  }

  const decision = decisions.length === 1 ? decisions[0] : undefined;
  const material = decision
    ? nodeAs(nodeById, decision.materialNodeId, 'material-context')
    : exactlyOne(materials);
  const source = decision
    ? nodeAs(nodeById, decision.sourceNodeId, 'source-pass')
    : exactlyOne(sources);
  const context = decision
    ? nodeAs(nodeById, decision.contextNodeId, 'shader-context')
    : exactlyOne(contexts);

  const evaluation: Evaluation = {
    graph,
    nodes,
    edges,
    nodeById,
    ...(material ? { material } : {}),
    ...(source ? { source } : {}),
    ...(context ? { context } : {}),
    ...(decision ? { decision } : {}),
    missing,
    contradictions,
  };

  validateEdges(evaluation);
  validatePrimaryIdentity(evaluation);
  const citedNodes = collectCitedNodes(evaluation);
  validateCorroboration(evaluation, citedNodes);

  const orderedMissing = uniqueMissing(missing);
  const orderedContradictions = uniqueContradictions(contradictions);
  const citations = citedNodes
    .map(citationForNode)
    .sort(compareCitations);
  const observation = observationFor(materials);
  const causalExplanation = causalExplanationFor(
    evaluation,
    orderedMissing,
    orderedContradictions,
    citations,
  );

  return {
    schemaVersion: PASS_EXPLANATION_SCHEMA_VERSION,
    question: PASS_EXPLANATION_QUESTION,
    graphId: graph.graphId,
    observation,
    causalExplanation,
    disclosures: {
      missing: orderedMissing,
      contradictions: orderedContradictions,
    },
    citations,
    suggestedEdits: [],
    execution: executionPolicy(),
  };
}

function nodesOfKind<K extends PassExplanationEvidenceNode['kind']>(
  nodes: readonly PassExplanationEvidenceNode[],
  kind: K,
): Extract<PassExplanationEvidenceNode, { readonly kind: K }>[] {
  return nodes.filter(
    (node): node is Extract<PassExplanationEvidenceNode, { readonly kind: K }> => (
      node.kind === kind
    ),
  );
}

function edgesOfKind<K extends PassExplanationEvidenceEdge['kind']>(
  edges: readonly PassExplanationEvidenceEdge[],
  kind: K,
): Extract<PassExplanationEvidenceEdge, { readonly kind: K }>[] {
  return edges.filter(
    (edge): edge is Extract<PassExplanationEvidenceEdge, { readonly kind: K }> => (
      edge.kind === kind
    ),
  );
}

function exactlyOne<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function nodeAs<K extends PassExplanationEvidenceNode['kind']>(
  nodes: ReadonlyMap<string, PassExplanationEvidenceNode>,
  id: string,
  kind: K,
): Extract<PassExplanationEvidenceNode, { readonly kind: K }> | undefined {
  const node = nodes.get(id);
  return node?.kind === kind
    ? node as Extract<PassExplanationEvidenceNode, { readonly kind: K }>
    : undefined;
}

function edgeEndpoints(
  edge: Exclude<PassExplanationEvidenceEdge, PassSelectionDecisionEdge>,
): readonly [string, string] {
  return [edge.fromNodeId, edge.toNodeId];
}

function expectedEdgeKinds(
  edge: Exclude<PassExplanationEvidenceEdge, PassSelectionDecisionEdge>,
): readonly [PassExplanationEvidenceNode['kind'], PassExplanationEvidenceNode['kind']] {
  switch (edge.kind) {
    case 'context-variant':
      return ['shader-context', 'variant'];
    case 'context-compiler':
      return ['shader-context', 'compiler'];
    case 'compiler-generated':
      return ['compiler', 'generated-source'];
    case 'generated-source-map':
      return ['generated-source', 'source-pass'];
  }
}

function validateEdges(evaluation: Evaluation): void {
  const {
    edges,
    nodeById,
    decision,
    contradictions,
  } = evaluation;

  for (const edge of edges) {
    if (edge.kind === 'selection-decision') {
      const refs = [
        [edge.materialNodeId, 'material-context'],
        [edge.contextNodeId, 'shader-context'],
        [edge.sourceNodeId, 'source-pass'],
      ] as const;
      for (const [id, expectedKind] of refs) {
        const node = nodeById.get(id);
        if (!node) {
          addContradiction(contradictions, {
            code: 'dangling-edge',
            detail: `Selection decision '${edge.id}' references missing node '${id}'.`,
            nodeIds: [id],
            edgeIds: [edge.id],
          });
        } else if (node.kind !== expectedKind) {
          addContradiction(contradictions, {
            code: 'edge-kind-mismatch',
            detail: `Selection decision '${edge.id}' expected '${expectedKind}' at '${id}', found '${node.kind}'.`,
            nodeIds: [id],
            edgeIds: [edge.id],
          });
        }
      }
      continue;
    }

    const [fromId, toId] = edgeEndpoints(edge);
    const [fromKind, toKind] = expectedEdgeKinds(edge);
    const from = nodeById.get(fromId);
    const to = nodeById.get(toId);
    if (!from || !to) {
      addContradiction(contradictions, {
        code: 'dangling-edge',
        detail: `Evidence edge '${edge.id}' references a missing endpoint.`,
        nodeIds: [fromId, toId],
        edgeIds: [edge.id],
      });
      continue;
    }
    if (from.kind !== fromKind || to.kind !== toKind) {
      addContradiction(contradictions, {
        code: 'edge-kind-mismatch',
        detail: `Evidence edge '${edge.id}' requires '${fromKind}' -> '${toKind}', found '${from.kind}' -> '${to.kind}'.`,
        nodeIds: [fromId, toId],
        edgeIds: [edge.id],
      });
    }
  }

  if (decision) {
    if (!evaluation.material) {
      addMissing(
        evaluation.missing,
        'material-context',
        true,
        `Selection decision '${decision.id}' has no valid Material endpoint.`,
      );
    }
    if (!evaluation.context) {
      addMissing(
        evaluation.missing,
        'shader-context',
        true,
        `Selection decision '${decision.id}' has no valid Shader Context endpoint.`,
      );
    }
    if (!evaluation.source) {
      addMissing(
        evaluation.missing,
        'source-pass',
        true,
        `Selection decision '${decision.id}' has no valid source Pass endpoint.`,
      );
    }
  }
}

function validatePrimaryIdentity(evaluation: Evaluation): void {
  const {
    material,
    source,
    context,
    decision,
    missing,
    contradictions,
  } = evaluation;
  const selected = material?.context.selectedProgram;
  const captured = context?.correlation.context;
  const captureProvenance = context?.correlation.evidence.provenance;
  if (material && !passIdentified(selected)) {
    addMissing(
      missing,
      'selected-program',
      true,
      `Material selection '${material.context.selectionId}' does not identify a Pass.`,
    );
  }

  if (material && source) {
    if (passIdentified(selected) && !samePass(selected, source.program)) {
      addContradiction(contradictions, {
        code: 'selected-program-mismatch',
        detail: 'Observed Material Pass does not match the cited source Pass.',
        nodeIds: [material.id, source.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (material.context.shader.name !== source.program.shaderName) {
      addContradiction(contradictions, {
        code: 'shader-identity-mismatch',
        detail: 'Material Shader name does not match the cited source Shader.',
        nodeIds: [material.id, source.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (!sourceIdentityMatchesRevision(
      source.source,
      material.context.shader.revision,
    )) {
      addContradiction(contradictions, {
        code: 'source-revision-mismatch',
        detail: 'Material Shader revision does not match the exact source snapshot.',
        nodeIds: [material.id, source.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
  }

  if (material && context && captured && captureProvenance) {
    if (passIdentified(selected) && !samePass(selected, captured)) {
      addContradiction(contradictions, {
        code: 'selected-program-mismatch',
        detail: 'Observed Material Pass does not match the cited Shader Context.',
        nodeIds: [material.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (material.context.shader.name !== captured.shaderName) {
      addContradiction(contradictions, {
        code: 'shader-identity-mismatch',
        detail: 'Material Shader name does not match the cited Shader Context.',
        nodeIds: [material.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (!sameRevision(
      captureProvenance.sourceRevision,
      material.context.shader.revision,
    )) {
      addContradiction(contradictions, {
        code: 'source-revision-mismatch',
        detail: 'Shader Context provenance does not match the Material Shader revision.',
        nodeIds: [material.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (
      captureProvenance.projectId
      !== material.context.provenance.projectId
    ) {
      addContradiction(contradictions, {
        code: 'project-identity-mismatch',
        detail: 'Shader Context and Material Context belong to different projects.',
        nodeIds: [material.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (
      captureProvenance.instanceId
      !== material.context.provenance.instanceId
    ) {
      addContradiction(contradictions, {
        code: 'instance-identity-mismatch',
        detail: 'Shader Context and Material Context came from different Editor instances.',
        nodeIds: [material.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
  }

  if (source && context && captured && captureProvenance) {
    if (!samePass(source.program, captured)) {
      addContradiction(contradictions, {
        code: 'shader-context-mismatch',
        detail: 'Shader Context Pass does not match the exact source Pass.',
        nodeIds: [source.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (source.program.shaderName !== captured.shaderName) {
      addContradiction(contradictions, {
        code: 'shader-identity-mismatch',
        detail: 'Shader Context name does not match the cited source Shader.',
        nodeIds: [source.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    const stage = source.program.stages.find(({ stage: candidate }) => (
      candidate === captured.stage
    ));
    if (!stage || stage.entryPoint !== captured.entryPoint) {
      addContradiction(contradictions, {
        code: 'shader-context-mismatch',
        detail: 'Shader Context stage/entry point is absent from the cited source Pass.',
        nodeIds: [source.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (!sourceIdentityMatchesRevision(
      source.source,
      captureProvenance.sourceRevision,
    )) {
      addContradiction(contradictions, {
        code: 'source-revision-mismatch',
        detail: 'Shader Context capture does not match the exact source revision.',
        nodeIds: [source.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    const mapping = context.correlation.evidence.mapping;
    if (
      !hasVerifiedTraceIdentity(context.correlation)
      || mapping.status !== 'mapped'
      || uriKey(context.correlation.uri) !== uriKey(source.source.uri)
      || !containsRange(source.range, context.correlation.range)
      || (
        mapping.status === 'mapped'
        && (
          uriKey(mapping.uri) !== uriKey(context.correlation.uri)
          || !sameRange(mapping.range, context.correlation.range)
          || mapping.expectedText !== captured.entryPoint
          || mapping.sourceEntryPoint !== captured.entryPoint
          || !rangeMatchesExactText(
            context.correlation.range,
            mapping.expectedText,
          )
        )
      )
    ) {
      addContradiction(contradictions, {
        code: 'shader-context-mismatch',
        detail: 'Shader Context is not a current verified trace mapped inside the exact source Pass.',
        nodeIds: [source.id, context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
    if (!sameCapturedContext(context.correlation.evidence.context, captured)) {
      addContradiction(contradictions, {
        code: 'shader-context-mismatch',
        detail: 'Shader Context envelope does not match its captured draw evidence.',
        nodeIds: [context.id],
        edgeIds: decision ? [decision.id] : [],
      });
    }
  }

  if (decision) {
    const evidence = decision.decision;
    const materialMismatch = material !== undefined && (
      evidence.selectionId !== material.context.selectionId
      || material.context.provenance.sourceRevision
        !== material.context.selectionId
      || (
        passIdentified(material.context.selectedProgram)
        && !samePass(evidence.program, material.context.selectedProgram)
      )
      || !sameRevision(
        evidence.materialRevision,
        material.context.material.revision,
      )
      || !sameRevision(
        evidence.shaderRevision,
        material.context.shader.revision,
      )
      || evidence.provenance.projectId
        !== material.context.provenance.projectId
      || evidence.provenance.instanceId
        !== material.context.provenance.instanceId
      || evidence.provenance.adapterVersion
        !== material.context.provenance.adapterVersion
      || evidence.provenance.unityVersion
        !== material.context.provenance.unityVersion
    );
    const sourceMismatch = source !== undefined && (
      !samePass(evidence.program, source.program)
      || !sourceIdentityMatchesRevision(
        source.source,
        evidence.shaderRevision,
      )
    );
    const contextMismatch = captured !== undefined
      && captureProvenance !== undefined
      && (
        evidence.contextId !== captured.id
        || !samePass(evidence.program, captured)
        || !sameRevision(
          evidence.shaderRevision,
          captureProvenance.sourceRevision,
        )
        || evidence.provenance.projectId !== captureProvenance.projectId
        || evidence.provenance.instanceId !== captureProvenance.instanceId
        || evidence.provenance.adapterVersion
          !== captureProvenance.adapterVersion
        || evidence.provenance.unityVersion !== captureProvenance.unityVersion
      );
    if (materialMismatch || sourceMismatch || contextMismatch) {
      addContradiction(contradictions, {
        code: 'decision-provenance-mismatch',
        detail: 'Selection decision identity does not match its Material, Shader Context, and source endpoints.',
        nodeIds: [
          ...(material ? [material.id] : []),
          ...(context ? [context.id] : []),
          ...(source ? [source.id] : []),
        ],
        edgeIds: [decision.id],
      });
    }
  }
}

function passIdentified(
  program: MaterialContextProgram | undefined,
): program is MaterialContextProgram {
  return program !== undefined
    && (program.passIndex !== undefined || program.passName !== undefined);
}

function samePass(
  left: {
    readonly subShaderIndex: number;
    readonly passIndex?: number;
    readonly passName?: string;
  },
  right: {
    readonly subShaderIndex: number;
    readonly passIndex?: number;
    readonly passName?: string;
  },
): boolean {
  if (left.subShaderIndex !== right.subShaderIndex) return false;
  if (
    left.passIndex !== undefined
    && right.passIndex !== undefined
    && left.passIndex !== right.passIndex
  ) return false;
  if (
    left.passName !== undefined
    && right.passName !== undefined
    && left.passName !== right.passName
  ) return false;
  return (
    left.passIndex !== undefined && right.passIndex !== undefined
  ) || (
    left.passName !== undefined && right.passName !== undefined
  );
}

function sameCapturedContext(
  left: PassExplanationContextNode['correlation']['context'],
  right: PassExplanationContextNode['correlation']['context'],
): boolean {
  return left.id === right.id
    && left.shaderName === right.shaderName
    && left.subShaderIndex === right.subShaderIndex
    && left.passIndex === right.passIndex
    && left.passName === right.passName
    && left.stage === right.stage
    && left.entryPoint === right.entryPoint
    && left.keywords.incomplete === right.keywords.incomplete
    && left.keywords.enabled.length === right.keywords.enabled.length
    && left.keywords.enabled.every((keyword, index) => (
      keyword === right.keywords.enabled[index]
    ));
}

function hasVerifiedTraceIdentity(
  correlation: PassExplanationContextNode['correlation'],
): boolean {
  const verification = correlation.traceVerification;
  const trace = correlation.evidence.draw.trace;
  return correlation.traceStatus === 'verified-local-trace'
    && verification.status === 'verified-local-trace'
    && verification.fileName === trace.fileName
    && verification.sha256 === trace.sha256
    && verification.byteLength === trace.byteLength
    && verification.labels.includes(correlation.evidence.draw.label);
}

function sameRevision(
  left: AdapterSourceRevision,
  right: AdapterSourceRevision,
): boolean {
  return uriKey(left.uri) === uriKey(right.uri)
    && left.assetGuid.toLowerCase() === right.assetGuid.toLowerCase()
    && left.contentHash.toLowerCase() === right.contentHash.toLowerCase();
}

function sourceIdentityMatchesRevision(
  source: CompilerSourceIdentity,
  revision: AdapterSourceRevision,
): boolean {
  return uriKey(source.uri) === uriKey(revision.uri)
    && source.sourceId.toLowerCase() === revision.assetGuid.toLowerCase()
    && source.contentHash.toLowerCase() === revision.contentHash.toLowerCase();
}

function sameCompilerProvenance(
  left: CompilerEvidenceProvenance,
  right: CompilerEvidenceProvenance,
): boolean {
  return left.capability === right.capability
    && left.adapterVersion === right.adapterVersion
    && left.unityVersion === right.unityVersion
    && left.projectId === right.projectId
    && left.instanceId === right.instanceId
    && left.collectedAt === right.collectedAt
    && left.contextId === right.contextId
    && sameRevision(left.sourceRevision, right.sourceRevision)
    && left.profile.name === right.profile.name
    && left.profile.platform === right.profile.platform
    && left.profile.graphicsApi === right.profile.graphicsApi
    && left.profile.capability === right.profile.capability;
}

function collectCitedNodes(evaluation: Evaluation): PassExplanationEvidenceNode[] {
  const selected = new Map<string, PassExplanationEvidenceNode>();
  const add = (node: PassExplanationEvidenceNode | undefined): boolean => {
    if (!node || selected.has(node.id)) return false;
    selected.set(node.id, node);
    return true;
  };
  for (const node of evaluation.nodes) {
    if (
      node.kind === 'material-context'
      || node.kind === 'source-pass'
      || node.kind === 'shader-context'
    ) add(node);
  }

  if (evaluation.context) {
    for (const edge of evaluation.edges) {
      if (
        edge.kind === 'context-variant'
        && edge.fromNodeId === evaluation.context.id
      ) add(evaluation.nodeById.get(edge.toNodeId));
      if (
        edge.kind === 'context-compiler'
        && edge.fromNodeId === evaluation.context.id
      ) add(evaluation.nodeById.get(edge.toNodeId));
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of evaluation.edges) {
      if (
        edge.kind === 'compiler-generated'
        && selected.has(edge.fromNodeId)
        && !selected.has(edge.toNodeId)
      ) {
        changed = add(evaluation.nodeById.get(edge.toNodeId)) || changed;
      }
      if (
        edge.kind === 'generated-source-map'
        && selected.has(edge.fromNodeId)
        && !selected.has(edge.toNodeId)
      ) {
        changed = add(evaluation.nodeById.get(edge.toNodeId)) || changed;
      }
    }
  }
  return [...selected.values()];
}

function validateCorroboration(
  evaluation: Evaluation,
  citedNodes: readonly PassExplanationEvidenceNode[],
): void {
  const {
    nodes,
    edges,
    material,
    source,
    context,
    missing,
    contradictions,
  } = evaluation;
  if (!context) {
    addMissing(
      missing,
      nodes.some(({ kind }) => kind === 'variant') ? 'context-variant-link' : 'variant',
      false,
      nodes.some(({ kind }) => kind === 'variant')
        ? 'Variant evidence exists but cannot be linked without exact Shader Context.'
        : 'No Variant corroboration is available.',
    );
    addMissing(
      missing,
      nodes.some(({ kind }) => kind === 'compiler') ? 'context-compiler-link' : 'compiler',
      false,
      nodes.some(({ kind }) => kind === 'compiler')
        ? 'Compiler evidence exists but cannot be linked without exact Shader Context.'
        : 'No compiler corroboration is available.',
    );
    addMissing(
      missing,
      nodes.some(({ kind }) => kind === 'generated-source')
        ? 'compiler-generated-link'
        : 'generated-source',
      false,
      nodes.some(({ kind }) => kind === 'generated-source')
        ? 'Generated-source evidence exists but cannot be linked without compiler evidence.'
        : 'No generated-source corroboration is available.',
    );
    return;
  }

  const variants = citedNodes.filter(
    (node): node is PassExplanationVariantNode => node.kind === 'variant',
  );
  const compilers = citedNodes.filter(
    (node): node is PassExplanationCompilerNode => node.kind === 'compiler',
  );
  const generated = citedNodes.filter(
    (node): node is PassExplanationGeneratedNode => node.kind === 'generated-source',
  );
  const captured = context.correlation.context;
  const captureProvenance = context.correlation.evidence.provenance;

  if (variants.length === 0) {
    addMissing(
      missing,
      nodes.some(({ kind }) => kind === 'variant') ? 'context-variant-link' : 'variant',
      false,
      nodes.some(({ kind }) => kind === 'variant')
        ? 'Variant evidence exists but is not linked to the selected Shader Context.'
        : 'No Variant corroboration is available.',
    );
  }
  if (compilers.length === 0) {
    addMissing(
      missing,
      nodes.some(({ kind }) => kind === 'compiler') ? 'context-compiler-link' : 'compiler',
      false,
      nodes.some(({ kind }) => kind === 'compiler')
        ? 'Compiler evidence exists but is not linked to the selected Shader Context.'
        : 'No compiler corroboration is available.',
    );
  }
  if (generated.length === 0) {
    const generatedExists = nodes.some(({ kind }) => kind === 'generated-source');
    addMissing(
      missing,
      generatedExists ? 'compiler-generated-link' : 'generated-source',
      false,
      generatedExists
        ? 'Generated-source evidence exists but is not linked to cited compiler evidence.'
        : 'No generated-source corroboration is available.',
    );
  }

  for (const variant of variants) {
    if (
      !samePass(variant.context, captured)
      || variant.context.shaderName !== captured.shaderName
      || variant.context.stage !== captured.stage
      || variant.context.graphicsApi !== captureProvenance.graphicsApi
    ) {
      addContradiction(contradictions, {
        code: 'variant-context-mismatch',
        detail: 'Variant evidence does not identify the selected Shader Context.',
        nodeIds: [context.id, variant.id],
        edgeIds: connectingEdgeIds(edges, context.id, variant.id),
      });
    }
    if (
      material
      && (
        variant.build.provenance.projectId
          !== material.context.provenance.projectId
        || variant.build.provenance.instanceId
          !== material.context.provenance.instanceId
      )
    ) {
      addContradiction(contradictions, {
        code: variant.build.provenance.projectId
          !== material.context.provenance.projectId
          ? 'project-identity-mismatch'
          : 'instance-identity-mismatch',
        detail: 'Variant evidence provenance does not match the Material Context session.',
        nodeIds: [material.id, variant.id],
        edgeIds: connectingEdgeIds(edges, context.id, variant.id),
      });
    }
    if (
      material
      && (
        variant.build.provenance.adapterVersion
          !== material.context.provenance.adapterVersion
        || variant.build.provenance.unityVersion
          !== material.context.provenance.unityVersion
      )
    ) {
      addContradiction(contradictions, {
        code: 'adapter-session-mismatch',
        detail: 'Variant evidence Adapter/Unity version does not match the Material Context session.',
        nodeIds: [material.id, variant.id],
        edgeIds: connectingEdgeIds(edges, context.id, variant.id),
      });
    }
    if (
      source
      && !sourceIdentityMatchesRevision(
        source.source,
        variant.build.provenance.sourceRevision,
      )
    ) {
      addContradiction(contradictions, {
        code: 'source-revision-mismatch',
        detail: 'Variant evidence does not match the exact source revision.',
        nodeIds: [source.id, variant.id],
        edgeIds: connectingEdgeIds(edges, context.id, variant.id),
      });
    }
  }

  for (const compiler of compilers) {
    const record = compiler.record;
    if (
      record.status !== 'current'
      || record.contextId !== captured.id
      || record.provenance.contextId !== captured.id
    ) {
      addContradiction(contradictions, {
        code: 'compiler-context-mismatch',
        detail: 'Compiler evidence is stale or its contextId does not match the selected Shader Context.',
        nodeIds: [context.id, compiler.id],
        edgeIds: connectingEdgeIds(edges, context.id, compiler.id),
      });
    }
    if (
      record.profile.graphicsApi !== captureProvenance.graphicsApi
      || record.provenance.profile.graphicsApi
        !== captureProvenance.graphicsApi
    ) {
      addContradiction(contradictions, {
        code: 'compiler-profile-mismatch',
        detail: 'Compiler graphics API does not match the selected Shader Context.',
        nodeIds: [context.id, compiler.id],
        edgeIds: connectingEdgeIds(edges, context.id, compiler.id),
      });
    }
    if (
      material
      && (
        record.provenance.projectId !== material.context.provenance.projectId
        || record.provenance.instanceId
          !== material.context.provenance.instanceId
      )
    ) {
      addContradiction(contradictions, {
        code: record.provenance.projectId
          !== material.context.provenance.projectId
          ? 'project-identity-mismatch'
          : 'instance-identity-mismatch',
        detail: 'Compiler evidence provenance does not match the Material Context session.',
        nodeIds: [material.id, compiler.id],
        edgeIds: connectingEdgeIds(edges, context.id, compiler.id),
      });
    }
    if (
      material
      && (
        record.provenance.adapterVersion
          !== material.context.provenance.adapterVersion
        || record.provenance.unityVersion
          !== material.context.provenance.unityVersion
      )
    ) {
      addContradiction(contradictions, {
        code: 'adapter-session-mismatch',
        detail: 'Compiler evidence Adapter/Unity version does not match the Material Context session.',
        nodeIds: [material.id, compiler.id],
        edgeIds: connectingEdgeIds(edges, context.id, compiler.id),
      });
    }
    if (
      source
      && (
        uriKey(record.sourceUri) !== uriKey(source.source.uri)
        || !sourceIdentityMatchesRevision(
          source.source,
          record.provenance.sourceRevision,
        )
      )
    ) {
      addContradiction(contradictions, {
        code: 'source-revision-mismatch',
        detail: 'Compiler evidence does not match the exact source revision.',
        nodeIds: [source.id, compiler.id],
        edgeIds: connectingEdgeIds(edges, context.id, compiler.id),
      });
    }
  }

  for (const variant of variants) {
    for (const compiler of compilers) {
      if (
        variant.build.provenance.buildTarget
          !== compiler.record.profile.platform
        || variant.build.provenance.buildTarget
          !== compiler.record.provenance.profile.platform
      ) {
        addContradiction(contradictions, {
          code: 'compiler-profile-mismatch',
          detail: 'Variant build target does not match the linked compiler platform.',
          nodeIds: [context.id, variant.id, compiler.id],
          edgeIds: [
            ...connectingEdgeIds(edges, context.id, variant.id),
            ...connectingEdgeIds(edges, context.id, compiler.id),
          ],
        });
      }
    }
  }

  for (const generatedNode of generated) {
    const compilerEdges = edges.filter(
      (edge): edge is Extract<
        PassExplanationEvidenceEdge,
        { readonly kind: 'compiler-generated' }
      > => (
        edge.kind === 'compiler-generated'
        && edge.toNodeId === generatedNode.id
        && compilers.some(({ id }) => id === edge.fromNodeId)
      ),
    );
    const sourceEdges = edges.filter(
      (edge): edge is Extract<
        PassExplanationEvidenceEdge,
        { readonly kind: 'generated-source-map' }
      > => (
        edge.kind === 'generated-source-map'
        && edge.fromNodeId === generatedNode.id
        && source?.id === edge.toNodeId
      ),
    );
    if (sourceEdges.length === 0) {
      addMissing(
        missing,
        'generated-source-map-link',
        false,
        `Generated evidence '${generatedNode.id}' has no exact link to the cited source Pass.`,
      );
    }
    const linkedCompilers = compilerEdges
      .map(({ fromNodeId }) => compilers.find(({ id }) => id === fromNodeId))
      .filter((node): node is PassExplanationCompilerNode => node !== undefined);
    const compilerMatches = linkedCompilers.length === 1
      && linkedCompilers.every((compiler) => (
        compiler.record.status === 'current'
        && generatedNode.evidenceId === compiler.record.evidenceId
        && compiler.record.views.some((view) => (
          view.kind === 'generated'
          && view.uri === generatedNode.view.uri
          && view.contentHash === generatedNode.document.contentHash
        ))
        && generatedNode.view.uri === compilerVirtualUri(
          generatedNode.evidenceId,
          'generated',
        )
        && sameCompilerProvenance(
          generatedNode.mapping.provenance.evidence,
          compiler.record.provenance,
        )
        && sameRange(
          generatedNode.document.range,
          generatedNode.mapping.generatedRange,
        )
        && generatedNode.mapping.provenance.directive.documentLine
          < generatedNode.mapping.generatedRange.start.line
        && generatedNode.mapping.provenance.directive.sourceLine
          === generatedNode.mapping.range.start.line
        && generatedNode.mapping.generatedRange.start.character
          === generatedNode.mapping.range.start.character
        && generatedNode.mapping.generatedRange.end.character
          === generatedNode.mapping.range.end.character
        && sourceNameMatchesUri(
          generatedNode.mapping.uri,
          generatedNode.mapping.provenance.directive.sourceName,
        )
      ));
    const sourceMatches = source !== undefined
      && uriKey(generatedNode.mapping.uri) === uriKey(source.source.uri)
      && sameSourceIdentity(generatedNode.mapping.sourceIdentity, source.source)
      && containsRange(source.range, generatedNode.mapping.range);
    if (!compilerMatches || !sourceMatches) {
      addContradiction(contradictions, {
        code: 'generated-mapping-mismatch',
        detail: 'Generated-source mapping does not match its compiler evidence and exact source Pass.',
        nodeIds: [
          generatedNode.id,
          ...linkedCompilers.map(({ id }) => id),
          ...(source ? [source.id] : []),
        ],
        edgeIds: [
          ...compilerEdges.map(({ id }) => id),
          ...sourceEdges.map(({ id }) => id),
        ],
      });
    }
  }
}

function connectingEdgeIds(
  edges: readonly PassExplanationEvidenceEdge[],
  leftId: string,
  rightId: string,
): string[] {
  return edges.flatMap((edge) => {
    if (edge.kind === 'selection-decision') return [];
    return edge.fromNodeId === leftId && edge.toNodeId === rightId
      ? [edge.id]
      : [];
  });
}

function sameSourceIdentity(
  left: CompilerSourceIdentity,
  right: CompilerSourceIdentity,
): boolean {
  return uriKey(left.uri) === uriKey(right.uri)
    && left.sourceId.toLowerCase() === right.sourceId.toLowerCase()
    && left.contentHash.toLowerCase() === right.contentHash.toLowerCase();
}

function sameRange(left: Range, right: Range): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function rangeMatchesExactText(range: Range, text: string): boolean {
  return range.start.line === range.end.line
    && range.end.character - range.start.character === text.length;
}

function containsRange(container: Range, nested: Range): boolean {
  return positionAtOrBefore(container.start, nested.start)
    && positionAtOrBefore(nested.end, container.end);
}

function compilerVirtualUri(
  evidenceId: string,
  kind: 'preprocessed' | 'generated',
): string {
  return `unity-shader-nav-compiler://evidence/${evidenceId}/${kind}.hlsl`;
}

function positionAtOrBefore(
  left: Range['start'],
  right: Range['start'],
): boolean {
  return left.line < right.line
    || (left.line === right.line && left.character <= right.character);
}

// Each interpolated evidence field is bounded to 16KiB before the engine
// runs, but a statement composes several of them, and the client re-validates
// the composed statement against that same per-text bound. Clip every
// interpolated fragment so the composition cannot overflow it (worst case:
// the supported causal statement interpolates four free-text fragments).
const MAX_STATEMENT_FRAGMENT_LENGTH = 2 * 1_024;

function statementFragment(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= MAX_STATEMENT_FRAGMENT_LENGTH) return text;
  return `${characters.slice(0, MAX_STATEMENT_FRAGMENT_LENGTH).join('')}…`;
}

function observationFor(
  materials: readonly PassExplanationMaterialNode[],
): PassSelectionObservation {
  if (materials.length === 0) {
    return {
      status: 'not-observed',
      reason: 'material-context-missing',
      statement: 'No current Material Context selection was observed.',
      citationNodeIds: [],
    };
  }
  if (materials.length > 1) {
    return {
      status: 'not-observed',
      reason: 'material-context-ambiguous',
      statement: 'Multiple Material Context selections were supplied; none is reported as current.',
      // Duplicate node ids are already disclosed as contradictions; the
      // client rejects repeated ids in citationNodeIds.
      citationNodeIds: [...new Set(materials.map(({ id }) => id))].sort(ordinalCompare),
    };
  }
  const material = materials[0];
  const selected = material.context.selectedProgram;
  if (!passIdentified(selected)) {
    return {
      status: 'not-observed',
      reason: 'selected-program-unavailable',
      statement: `Material '${statementFragment(material.context.material.name)}' does not report a selected Pass.`,
      citationNodeIds: [material.id],
    };
  }
  return {
    status: 'observed',
    statement: `Material '${statementFragment(material.context.material.name)}' reports ${formatPass(selected!)} in Shader '${statementFragment(material.context.shader.name)}'.`,
    materialName: material.context.material.name,
    shaderName: material.context.shader.name,
    selectedProgram: cloneJson(selected!),
    citationNodeIds: [material.id],
  };
}

function formatPass(program: MaterialContextProgram): string {
  const pass = program.passName !== undefined
    ? `Pass '${statementFragment(program.passName)}'${program.passIndex !== undefined ? ` (index ${program.passIndex})` : ''}`
    : `Pass index ${program.passIndex}`;
  return `SubShader ${program.subShaderIndex}, ${pass}`;
}

function causalExplanationFor(
  evaluation: Evaluation,
  missing: readonly PassExplanationMissingEvidence[],
  contradictions: readonly PassExplanationContradiction[],
  citations: readonly PassExplanationCitation[],
): PassCausalExplanation {
  const citationNodeIds = citations.map(({ nodeId }) => nodeId);
  if (contradictions.length > 0) {
    return {
      status: 'refused',
      reason: contradictions.some(({ code }) => INVALID_CODES.has(code))
        ? 'invalid-evidence'
        : 'contradictory-evidence',
      statement: 'No causal explanation is claimed because the evidence graph is contradictory.',
      citationNodeIds,
    };
  }
  if (missing.some(({ blocksCausalClaim }) => blocksCausalClaim)) {
    return {
      status: 'refused',
      reason: 'insufficient-evidence',
      statement: 'No causal explanation is claimed because authoritative selection evidence is incomplete.',
      citationNodeIds,
    };
  }
  const {
    material,
    source,
    context,
    decision,
  } = evaluation;
  if (!material || !source || !context || !decision) {
    return {
      status: 'refused',
      reason: 'insufficient-evidence',
      statement: 'No causal explanation is claimed because authoritative selection evidence is incomplete.',
      citationNodeIds,
    };
  }
  return {
    status: 'supported',
    reason: 'authoritative-selection-decision',
    statement: `Authoritative Adapter decision '${decision.decision.decisionId}' reports "${statementFragment(decision.decision.rationale.summary)}" (rule '${decision.decision.rationale.ruleId}') and links Material '${statementFragment(material.context.material.name)}' to ${formatPass(context.correlation.context)} in exact source Shader '${statementFragment(source.program.shaderName)}'.`,
    decision: cloneJson(decision),
    citationNodeIds,
  };
}

function citationForNode(node: PassExplanationEvidenceNode): PassExplanationCitation {
  switch (node.kind) {
    case 'source-pass':
      return cloneJson({
        nodeId: node.id,
        kind: node.kind,
        source: node.source,
        program: node.program,
        range: node.range,
      });
    case 'material-context':
      return cloneJson({
        nodeId: node.id,
        kind: node.kind,
        selectionId: node.context.selectionId,
        material: node.context.material,
        shader: node.context.shader,
        ...(node.context.selectedProgram
          ? { selectedProgram: node.context.selectedProgram }
          : {}),
        provenance: node.context.provenance,
      });
    case 'shader-context':
      return cloneJson({
        nodeId: node.id,
        kind: node.kind,
        correlation: node.correlation,
      });
    case 'variant':
      return cloneJson({
        nodeId: node.id,
        kind: node.kind,
        build: node.build,
        context: node.context,
      });
    case 'compiler':
      return cloneJson({
        nodeId: node.id,
        kind: node.kind,
        record: node.record,
      });
    case 'generated-source':
      return cloneJson({
        nodeId: node.id,
        kind: node.kind,
        evidenceId: node.evidenceId,
        view: node.view,
        document: node.document,
        mapping: node.mapping,
      });
  }
}

function compareCitations(
  left: PassExplanationCitation,
  right: PassExplanationCitation,
): number {
  const byKind = (CITATION_ORDER.get(left.kind) ?? 99)
    - (CITATION_ORDER.get(right.kind) ?? 99);
  return byKind || ordinalCompare(left.nodeId, right.nodeId);
}

function addMissing(
  target: PassExplanationMissingEvidence[],
  evidence: PassExplanationEvidenceRequirement,
  blocksCausalClaim: boolean,
  detail: string,
): void {
  target.push({ evidence, blocksCausalClaim, detail });
}

function addContradiction(
  target: PassExplanationContradiction[],
  contradiction: PassExplanationContradiction,
): void {
  // A hostile or buggy graph can make one disclosure name the same id twice
  // (a self-loop edge, or two primary nodes sharing an id). The client
  // validates every disclosure id array as a set and rejects repeats, so the
  // engine must never emit them.
  target.push({
    ...contradiction,
    nodeIds: [...new Set(contradiction.nodeIds)].sort(ordinalCompare),
    edgeIds: [...new Set(contradiction.edgeIds)].sort(ordinalCompare),
  });
}

function uniqueMissing(
  values: readonly PassExplanationMissingEvidence[],
): PassExplanationMissingEvidence[] {
  const unique = new Map<string, PassExplanationMissingEvidence>();
  for (const value of values) {
    const key = JSON.stringify([
      value.evidence,
      value.blocksCausalClaim,
      value.detail,
    ]);
    unique.set(key, value);
  }
  return [...unique.values()].sort((left, right) => (
    (MISSING_ORDER.get(left.evidence) ?? 99)
      - (MISSING_ORDER.get(right.evidence) ?? 99)
    || Number(right.blocksCausalClaim) - Number(left.blocksCausalClaim)
    || ordinalCompare(left.detail, right.detail)
  ));
}

function uniqueContradictions(
  values: readonly PassExplanationContradiction[],
): PassExplanationContradiction[] {
  const unique = new Map<string, PassExplanationContradiction>();
  for (const value of values) {
    const key = JSON.stringify([
      value.code,
      value.detail,
      value.nodeIds,
      value.edgeIds,
    ]);
    unique.set(key, value);
  }
  const ordered = [...unique.values()].sort((left, right) => (
    ordinalCompare(left.code, right.code)
    || ordinalCompare(left.detail, right.detail)
    || ordinalCompare(JSON.stringify(left.nodeIds), JSON.stringify(right.nodeIds))
    || ordinalCompare(JSON.stringify(left.edgeIds), JSON.stringify(right.edgeIds))
  ));
  if (ordered.length <= MAX_PASS_EXPLANATION_DISCLOSURES) return ordered;
  const bounded = ordered.slice(0, MAX_PASS_EXPLANATION_DISCLOSURES - 1);
  bounded.push({
    code: 'invalid-graph',
    detail: `Contradiction disclosure count ${ordered.length} exceeds ${MAX_PASS_EXPLANATION_DISCLOSURES}; remaining contradictions were omitted.`,
    nodeIds: [],
    edgeIds: [],
  });
  return bounded;
}
