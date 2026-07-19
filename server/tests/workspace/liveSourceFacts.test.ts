import { describe, expect, it } from 'vitest';
import type { ExactSource } from '../../src/sourceLocation';
import { prepareLiveSourceFacts } from '../../src/workspace/liveSourceFacts';

describe('prepareLiveSourceFacts', () => {
  it('computes the incoming block-comment state for every source line', () => {
    const text = [
      'float before; /* open',
      'still commented',
      'close */ float after;',
      'float4 literal = "/* not a comment */";',
    ].join('\n');

    expect(prepareLiveSourceFacts(text)).toMatchObject({
      sourceText: text,
      sourceLines: text.split('\n'),
      sourceBlockCommentStates: [false, true, true, false],
    });
  });

  it('recomputes incomplete prepared block-comment states', () => {
    const text = ['/* open', 'inside', 'close */'].join('\n');
    const prepared: ExactSource = {
      sourceText: text,
      sourceLines: text.split('\n'),
      sourceBlockCommentStates: [false],
    };

    const completed = prepareLiveSourceFacts(text, prepared);

    expect(completed).not.toBe(prepared);
    expect(completed.sourceBlockCommentStates).toEqual([false, true, true]);
  });

  it('reuses complete prepared block-comment entry states by identity', () => {
    const prepared: ExactSource = {
      sourceText: 'float value;',
      sourceLines: ['float value;'],
      sourceBlockCommentStates: [false],
    };

    expect(prepareLiveSourceFacts(prepared.sourceText, prepared)).toBe(prepared);
  });
});
