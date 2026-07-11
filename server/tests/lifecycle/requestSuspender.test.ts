import { describe, expect, it, vi } from 'vitest';
import { RequestSuspender } from '../../src/lifecycle/requestSuspender';

describe('RequestSuspender', () => {
  it('runs work immediately when not suspended', async () => {
    const suspender = new RequestSuspender({ timeoutMs: 1000 });

    await expect(suspender.run(async () => 42)).resolves.toBe(42);
  });

  it('suspends and resumes when released', async () => {
    vi.useFakeTimers();
    try {
      const suspender = new RequestSuspender({ timeoutMs: 1000 });
      suspender.suspend();

      const promise = suspender.run(async () => 'done');
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      suspender.release();
      await expect(promise).resolves.toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps requests suspended until overlapping releases complete', async () => {
    vi.useFakeTimers();
    try {
      const suspender = new RequestSuspender({ timeoutMs: 1000 });
      suspender.suspend();
      suspender.suspend();
      const work = vi.fn(async () => 'done');

      const promise = suspender.run(work);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });

      await Promise.resolve();
      suspender.release();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(work).not.toHaveBeenCalled();

      suspender.release();
      await expect(promise).resolves.toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out, detaches its waiter, and never runs stale work', async () => {
    vi.useFakeTimers();
    try {
      const suspender = new RequestSuspender({ timeoutMs: 100 });
      suspender.suspend();
      const work = vi.fn(async () => 'never');

      const promise = suspender.run(work);
      vi.advanceTimersByTime(100);

      await expect(promise).resolves.toBeNull();
      const waiters = Reflect.get(suspender, 'waiters') as Set<() => void>;
      expect(waiters.size).toBe(0);
      suspender.release();
      expect(work).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
