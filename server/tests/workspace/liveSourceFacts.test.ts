import { describe, expect, it } from 'vitest';
import type { ExactSource } from '../../src/sourceLocation';
import { prepareLiveSourceFacts } from '../../src/workspace/liveSourceFacts';

describe('prepareLiveSourceFacts', () => {
  it('reuses complete prepared block-comment entry states by identity', () => {
    const prepared: ExactSource = {
      sourceText: 'float value;',
      sourceLines: ['float value;'],
      sourceBlockCommentStates: [false],
    };

    expect(prepareLiveSourceFacts(prepared.sourceText, prepared)).toBe(prepared);
  });
});
