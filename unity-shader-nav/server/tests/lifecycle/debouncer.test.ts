import { describe, expect, it, vi } from 'vitest';
import { Debouncer } from '../../src/lifecycle/debouncer';

describe('Debouncer', () => {
  it('emits aggregated events after window', () => {
    vi.useFakeTimers();
    try {
      const fires: Array<{ batch: string[]; mode: string }> = [];
      const debouncer = new Debouncer<string>({ windowMs: 500, threshold: 5 }, (batch, mode) => {
        fires.push({ batch, mode });
      });

      debouncer.push('a');
      debouncer.push('b');
      debouncer.push('c');
      vi.advanceTimersByTime(499);
      expect(fires).toHaveLength(0);

      vi.advanceTimersByTime(2);
      expect(fires).toHaveLength(1);
      expect(fires[0].mode).toBe('incremental');
      expect(fires[0].batch).toEqual(['a', 'b', 'c']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches to rebuild mode when threshold exceeded', () => {
    vi.useFakeTimers();
    try {
      const fires: Array<{ batch: number[]; mode: string }> = [];
      const debouncer = new Debouncer<number>({ windowMs: 500, threshold: 5 }, (batch, mode) => {
        fires.push({ batch, mode });
      });

      for (let i = 0; i < 10; i++) debouncer.push(i);
      vi.advanceTimersByTime(500);

      expect(fires).toHaveLength(1);
      expect(fires[0].mode).toBe('rebuild');
    } finally {
      vi.useRealTimers();
    }
  });
});
