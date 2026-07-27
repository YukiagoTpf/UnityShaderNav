import type { PassExplanationAnswer } from '@unity-shader-nav/shared';
import type { CancellationToken } from 'vscode-languageserver/node';
import {
  explainPassSelection,
  suspendedAnswer,
} from './passExplanationEngine';
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

  /**
   * Fixed not-evaluated answer used only when the common request boundary
   * suspends. Deliberately not an empty-graph evaluation: that would read
   * byte-identical to a genuinely absent Material Context.
   */
  neutral(uri: string): PassExplanationAnswer {
    return suspendedAnswer(uri);
  }
}
