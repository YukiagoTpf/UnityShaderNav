import { describe, expect, it, vi } from 'vitest';
import {
  IndexInfrastructureError,
  IndexLifecycle,
} from '../../src/workspace/indexLifecycle';

describe('IndexLifecycle', () => {
  it('starts indexing and advances one revision per successful operation', () => {
    const changed = vi.fn();
    const lifecycle = new IndexLifecycle(changed);

    expect(lifecycle.snapshot()).toEqual({ state: 'indexing', operation: 'initial' });
    expect(lifecycle.canServe()).toBe(false);

    lifecycle.complete();
    expect(lifecycle.snapshot()).toEqual({ state: 'ready', revision: 1, warningCount: 0 });
    expect(lifecycle.canServe()).toBe(true);

    lifecycle.begin('rebuild');
    expect(lifecycle.snapshot()).toEqual({ state: 'indexing', operation: 'rebuild' });
    expect(lifecycle.canServe()).toBe(false);

    lifecycle.complete(2);
    expect(lifecycle.snapshot()).toEqual({ state: 'ready', revision: 2, warningCount: 2 });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('keeps revision unchanged across failure and labels the next attempt recovery', () => {
    const lifecycle = new IndexLifecycle();
    lifecycle.complete();
    lifecycle.begin('rebuild');
    lifecycle.fail(new IndexInfrastructureError(
      'package-resolution',
      'Invalid\n Packages/packages-lock.json',
    ));

    expect(lifecycle.snapshot()).toEqual({
      state: 'failed',
      failure: {
        category: 'package-resolution',
        message: 'Invalid Packages/packages-lock.json',
      },
    });
    expect(lifecycle.nextRebuildOperation()).toBe('recovery');
    expect(lifecycle.canServe()).toBe(false);

    lifecycle.begin(lifecycle.nextRebuildOperation());
    expect(lifecycle.snapshot()).toEqual({ state: 'indexing', operation: 'recovery' });
    lifecycle.complete();
    expect(lifecycle.snapshot()).toEqual({ state: 'ready', revision: 2, warningCount: 0 });
  });

  it('classifies unexpected errors as indexing failures without stack output', () => {
    const lifecycle = new IndexLifecycle();
    lifecycle.fail(new Error('candidate invariant failed'));

    expect(lifecycle.snapshot()).toEqual({
      state: 'failed',
      failure: { category: 'indexing', message: 'candidate invariant failed' },
    });
  });

  it('rejects overlapping and terminal lifecycle transitions', () => {
    const lifecycle = new IndexLifecycle();

    expect(() => lifecycle.begin('rebuild')).toThrow(/initial is in progress/);
    lifecycle.complete();
    expect(() => lifecycle.complete()).toThrow(/from ready/);
    expect(() => lifecycle.begin('recovery')).toThrow(/expected rebuild/);

    lifecycle.begin('rebuild');
    lifecycle.fail(new Error('rebuild failed'));
    expect(() => lifecycle.fail(new Error('again'))).toThrow(/from failed/);
  });
});
