import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/workspace/concurrency';

describe('mapWithConcurrency', () => {
  it('returns an empty result for empty input', async () => {
    await expect(mapWithConcurrency([], 2, async (value) => value)).resolves.toEqual([]);
  });

  it('preserves input order when tasks finish out of order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (delayMs) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return delayMs / 10;
    });

    expect(result).toEqual([3, 1, 2]);
  });

  it('does not run more than the configured limit at once', async () => {
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value;
    });

    expect(maxActive).toBe(2);
  });

  it('rejects when a task fails', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('boom');
      return value;
    })).rejects.toThrow('boom');
  });

  it('waits for in-flight workers and stops scheduling before rejecting', async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const started: number[] = [];
    let settled = false;
    const operation = mapWithConcurrency([1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 1) await slow;
      if (value === 2) throw new Error('boom');
      return value;
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([1, 2]);
    expect(settled).toBe(false);
    releaseSlow();
    await expect(operation).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});
