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

  it('times out and returns null after timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const suspender = new RequestSuspender({ timeoutMs: 100 });
      suspender.suspend();

      const promise = suspender.run(async () => 'never');
      vi.advanceTimersByTime(100);

      await expect(promise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
