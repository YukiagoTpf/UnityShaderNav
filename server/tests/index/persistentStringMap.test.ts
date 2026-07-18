import { describe, expect, it } from 'vitest';
import {
  PersistentOrderedMap,
  PersistentStringMap,
} from '../../src/index/persistentStringMap';

describe('PersistentStringMap', () => {
  it('path-copies set and delete without changing an older root', () => {
    let first = PersistentStringMap.empty<number>();
    for (let index = 0; index < 1_000; index++) {
      first = first.set(`key-${index.toString().padStart(4, '0')}`, index);
    }

    const replaced = first.set('key-0500', 5_000);
    const deleted = replaced.delete('key-0250');

    expect(first.size).toBe(1_000);
    expect(first.get('key-0500')).toBe(500);
    expect(first.get('key-0250')).toBe(250);
    expect(replaced.get('key-0500')).toBe(5_000);
    expect(deleted.has('key-0250')).toBe(false);
    expect(deleted.size).toBe(999);
    expect(first.set('key-0500', 500)).toBe(first);
    expect([...deleted.entries()].map(([key]) => key)).toEqual(
      [...deleted.entries()].map(([key]) => key).sort(),
    );
  });

  it('matches Map across deterministic mixed updates', () => {
    let persistent = PersistentStringMap.empty<number>();
    const expected = new Map<string, number>();
    let state = 0x12345678;

    for (let step = 0; step < 10_000; step++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const key = `key-${state % 750}`;
      if ((state & 3) === 0) {
        persistent = persistent.delete(key);
        expected.delete(key);
      } else {
        persistent = persistent.set(key, step);
        expected.set(key, step);
      }
    }

    expect(persistent.size).toBe(expected.size);
    expect([...persistent.entries()]).toEqual(
      [...expected.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
  });
});

describe('PersistentOrderedMap', () => {
  it('retains insertion order across replacements, deletion, and shared roots', () => {
    const first = PersistentOrderedMap.empty<number>()
      .set('b', 2)
      .set('a', 1)
      .set('c', 3);
    const replaced = first.set('a', 10);
    const moved = replaced.delete('b').set('b', 20);

    expect([...first.entries()]).toEqual([['b', 2], ['a', 1], ['c', 3]]);
    expect([...replaced.entries()]).toEqual([['b', 2], ['a', 10], ['c', 3]]);
    expect([...moved.entries()]).toEqual([['a', 10], ['c', 3], ['b', 20]]);
  });

  it('matches Map insertion order across deterministic mixed updates', () => {
    let persistent = PersistentOrderedMap.empty<number>();
    const expected = new Map<string, number>();
    let state = 0x87654321;
    for (let step = 0; step < 5_000; step++) {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      const key = `key-${state % 300}`;
      if ((state & 7) < 2) {
        persistent = persistent.delete(key);
        expected.delete(key);
      } else {
        persistent = persistent.set(key, step);
        expected.set(key, step);
      }
    }

    expect(persistent.size).toBe(expected.size);
    expect([...persistent.entries()]).toEqual([...expected.entries()]);
  });
});
