import { createHash } from 'node:crypto';
import {
  PASS_EXPLANATION_QUESTION,
  PASS_EXPLANATION_SCHEMA_VERSION,
  type PassExplanationAnswer,
  type PassExplanationEvidenceGraph,
} from '@unity-shader-nav/shared';
import type { CancellationToken } from 'vscode-languageserver/node';
import { explainPassSelection } from './passExplanationEngine';
import type { PassExplanationGraphProvider } from './passExplanationProjector';

/**
 * Stateless request service. Evidence and answers live only on the current
 * call stack; no graph, source text, answer, model input, or telemetry record
 * is retained.
 */
export class PassExplanationService {
  constructor(
    private readonly evidence: PassExplanationGraphProvider,
    /** Receives engine defects so they leave a trace instead of reading as bad project data. */
    private readonly reportInternalError?: (error: unknown) => void,
  ) {}

  async explain(
    uri: string,
    cancellation?: CancellationToken,
  ): Promise<PassExplanationAnswer> {
    return explainPassSelection(
      await this.evidence.graphFor(uri, cancellation),
      this.reportInternalError,
    );
  }

  /** Stable neutral answer used only when the common request boundary suspends. */
  neutral(uri: string): PassExplanationAnswer {
    return explainPassSelection(emptyGraph(uri));
  }
}

function emptyGraph(uri: string): PassExplanationEvidenceGraph {
  const graphId = createHash('sha256')
    .update('suspended\0', 'utf8')
    .update(uri, 'utf8')
    .digest('hex');
  return {
    schemaVersion: PASS_EXPLANATION_SCHEMA_VERSION,
    question: PASS_EXPLANATION_QUESTION,
    graphId: `pass-${graphId}`,
    nodes: [],
    edges: [],
  };
}
