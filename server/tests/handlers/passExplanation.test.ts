import type {
  CancellationToken,
  Connection,
} from 'vscode-languageserver/node';
import {
  PASS_EXPLANATION_QUESTION,
  PASS_EXPLANATION_REQUEST,
  PASS_EXPLANATION_SCHEMA_VERSION,
  type PassExplanationAnswer,
  type PassExplanationParams,
} from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PassExplanationService } from '../../src/explanation';
import { registerPassExplanationHandler } from '../../src/handlers/passExplanation';

type Handler = (
  params: PassExplanationParams,
  cancellation?: CancellationToken,
) => Promise<PassExplanationAnswer>;

function answer(graphId: string): PassExplanationAnswer {
  return {
    schemaVersion: PASS_EXPLANATION_SCHEMA_VERSION,
    question: PASS_EXPLANATION_QUESTION,
    graphId,
    observation: {
      status: 'not-observed',
      reason: 'material-context-missing',
      statement: 'No current Material Context selection was observed.',
      citationNodeIds: [],
    },
    causalExplanation: {
      status: 'refused',
      reason: 'insufficient-evidence',
      statement: 'No causal explanation is claimed.',
      citationNodeIds: [],
    },
    disclosures: { missing: [], contradictions: [] },
    citations: [],
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

describe('registerPassExplanationHandler', () => {
  it('registers one read-only request and delegates the exact URI', async () => {
    let registered: Handler | undefined;
    const connection = {
      onRequest(method: string, handler: Handler) {
        expect(method).toBe(PASS_EXPLANATION_REQUEST);
        registered = handler;
        return { dispose() {} };
      },
    } as unknown as Connection;
    const expected = answer('requested-answer');
    const explain = vi.fn(async () => expected);
    const neutral = vi.fn(() => answer('neutral-answer'));

    registerPassExplanationHandler(
      connection,
      { explain, neutral } as unknown as PassExplanationService,
    );
    if (!registered) throw new Error('Pass explanation handler was not registered');

    const uri = 'file:///project/Assets/Shaders/Lit.shader';
    const cancellation = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as CancellationToken;
    await expect(registered(
      { textDocument: { uri } },
      cancellation,
    )).resolves.toBe(expected);
    expect(explain).toHaveBeenCalledTimes(1);
    expect(explain).toHaveBeenCalledWith(uri, cancellation);
    expect(neutral).not.toHaveBeenCalled();
  });
});
