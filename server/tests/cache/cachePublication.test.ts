import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CacheFingerprint,
  type CacheManifest,
} from '@unity-shader-nav/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CacheManager,
  type CachePublicationInput,
} from '../../src/cache/cacheManager';
import { CacheStore } from '../../src/cache/cacheStore';

const fingerprint: CacheFingerprint = {
  indexImplementation: 'a'.repeat(64),
  grammarVersion: 'grammar',
  settingsHash: 'settings',
  macroTableHash: 'macros',
};

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function publication(marker: string): CachePublicationInput {
  const uri = 'file:///workspace/State.hlsl';
  return {
    workspaceFolderUri: 'file:///workspace',
    unityProjectRoot: '/workspace',
    fingerprint,
    files: [{
      uri,
      source: { mtimeMs: marker.length, size: marker.length },
      index: {
        uri,
        symbols: [{
          name: marker,
          kind: 'variable',
          location: { uri, range },
        }],
        references: [],
      },
    }],
  };
}

function manifestMarker(manifest: CacheManifest): string | undefined {
  return manifest.files[0]?.index.symbols[0]?.name;
}

function tracked<T>(promise: Promise<T>): {
  promise: Promise<T>;
  isSettled: () => boolean;
} {
  let settled = false;
  return {
    promise: promise.finally(() => {
      settled = true;
    }),
    isSettled: () => settled,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CacheManager publication scheduling', () => {
  it('establishes enqueue order before asynchronous manifest preparation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-preparation-order-'));
    const manager = new CacheManager(new CacheStore(dir));
    const activePreparationEntered = deferred();
    const releaseActivePreparation = deferred();
    const prepared: string[] = [];
    const saved: string[] = [];
    const originalSnapshot = manager.snapshot.bind(manager);
    const originalSave = CacheStore.prototype.save;
    vi.spyOn(manager, 'snapshot').mockImplementation(async (uri, index, source) => {
      const marker = index.symbols[0]?.name;
      if (marker) prepared.push(marker);
      if (marker === 'A') {
        activePreparationEntered.resolve();
        await releaseActivePreparation.promise;
      }
      return originalSnapshot(uri, index, source);
    });
    vi.spyOn(CacheStore.prototype, 'save').mockImplementation(async function save(manifest) {
      const marker = manifestMarker(manifest);
      if (marker) saved.push(marker);
      await originalSave.call(this, manifest);
    });

    try {
      const active = manager.persistPublication(publication('A'));
      await activePreparationEntered.promise;
      const superseded = tracked(manager.persistPublication(publication('B')));
      const latest = tracked(manager.persistPublication(publication('C')));

      await Promise.resolve();
      expect(prepared).toEqual(['A']);
      expect(saved).toEqual([]);
      expect(superseded.isSettled()).toBe(false);
      expect(latest.isSettled()).toBe(false);

      releaseActivePreparation.resolve();
      await Promise.all([active, superseded.promise, latest.promise]);

      expect(prepared).toEqual(['A', 'C']);
      expect(saved).toEqual(['A', 'C']);
      expect(manifestMarker((await manager.load())!)).toBe('C');
    } finally {
      releaseActivePreparation.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'one CacheManager', managerCount: 1 },
    { label: 'two CacheManagers sharing one manifest path', managerCount: 2 },
  ])('coalesces A/B/C to A/C for $label and settles B with C', async ({ managerCount }) => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-publication-'));
    const managers = Array.from(
      { length: managerCount },
      () => new CacheManager(new CacheStore(dir)),
    );
    const activeEntered = deferred();
    const releaseActive = deferred();
    const latestEntered = deferred();
    const releaseLatest = deferred();
    const saved: string[] = [];
    const originalSave = CacheStore.prototype.save;
    vi.spyOn(CacheStore.prototype, 'save').mockImplementation(async function save(manifest) {
      const marker = manifestMarker(manifest);
      if (marker) saved.push(marker);
      if (marker === 'A') {
        activeEntered.resolve();
        await releaseActive.promise;
      } else if (marker === 'C') {
        latestEntered.resolve();
        await releaseLatest.promise;
      }
      await originalSave.call(this, manifest);
    });

    try {
      const active = managers[0]!.persistPublication(publication('A'));
      await activeEntered.promise;
      const superseded = tracked(
        managers.at(-1)!.persistPublication(publication('B')),
      );
      const latest = tracked(managers[0]!.persistPublication(publication('C')));

      await Promise.resolve();
      expect(saved).toEqual(['A']);
      expect(superseded.isSettled()).toBe(false);
      expect(latest.isSettled()).toBe(false);

      releaseActive.resolve();
      await active;
      await latestEntered.promise;
      expect(saved).toEqual(['A', 'C']);
      expect(superseded.isSettled()).toBe(false);
      expect(latest.isSettled()).toBe(false);

      releaseLatest.resolve();
      await Promise.all([superseded.promise, latest.promise]);

      expect(manifestMarker((await managers[0]!.load())!)).toBe('C');
      expect(superseded.isSettled()).toBe(true);
      expect(latest.isSettled()).toBe(true);
    } finally {
      releaseActive.resolve();
      releaseLatest.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drains the latest pending publication after the active publication fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-active-failure-'));
    const manager = new CacheManager(new CacheStore(dir));
    const activeEntered = deferred();
    const releaseActive = deferred();
    const latestEntered = deferred();
    const releaseLatest = deferred();
    const activeError = new Error('active persistence failed');
    const saved: string[] = [];
    const originalSave = CacheStore.prototype.save;
    vi.spyOn(CacheStore.prototype, 'save').mockImplementation(async function save(manifest) {
      const marker = manifestMarker(manifest);
      if (marker) saved.push(marker);
      if (marker === 'A') {
        activeEntered.resolve();
        await releaseActive.promise;
        throw activeError;
      }
      if (marker === 'C') {
        latestEntered.resolve();
        await releaseLatest.promise;
      }
      await originalSave.call(this, manifest);
    });

    try {
      const activeResult = manager.persistPublication(publication('A')).then(
        () => undefined,
        (error: unknown) => error,
      );
      await activeEntered.promise;
      const superseded = tracked(manager.persistPublication(publication('B')));
      const latest = tracked(manager.persistPublication(publication('C')));

      releaseActive.resolve();
      expect(await activeResult).toBe(activeError);
      await latestEntered.promise;
      expect(saved).toEqual(['A', 'C']);
      expect(superseded.isSettled()).toBe(false);
      expect(latest.isSettled()).toBe(false);

      releaseLatest.resolve();
      await Promise.all([superseded.promise, latest.promise]);
      expect(manifestMarker((await manager.load())!)).toBe('C');
    } finally {
      releaseActive.resolve();
      releaseLatest.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the previous manifest when the latest replacement fails and permits retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usn-cache-latest-failure-'));
    const manager = new CacheManager(new CacheStore(dir));
    const activeEntered = deferred();
    const releaseActive = deferred();
    const replacementError = new Error('replacement persistence failed');
    const saved: string[] = [];
    const originalSave = CacheStore.prototype.save;
    const save = vi.spyOn(CacheStore.prototype, 'save').mockImplementation(
      async function saveManifest(manifest) {
        const marker = manifestMarker(manifest);
        if (marker) saved.push(marker);
        if (marker === 'A') {
          activeEntered.resolve();
          await releaseActive.promise;
          await originalSave.call(this, manifest);
          return;
        }
        if (marker === 'C') throw replacementError;
        await originalSave.call(this, manifest);
      },
    );

    try {
      const active = manager.persistPublication(publication('A'));
      await activeEntered.promise;
      const supersededResult = manager.persistPublication(publication('B')).then(
        () => undefined,
        (error: unknown) => error,
      );
      const latestResult = manager.persistPublication(publication('C')).then(
        () => undefined,
        (error: unknown) => error,
      );

      releaseActive.resolve();
      await active;
      expect(await supersededResult).toBe(replacementError);
      expect(await latestResult).toBe(replacementError);
      expect(saved).toEqual(['A', 'C']);
      expect(manifestMarker((await manager.load())!)).toBe('A');

      save.mockRestore();
      await manager.persistPublication(publication('C'));
      expect(manifestMarker((await manager.load())!)).toBe('C');
    } finally {
      releaseActive.resolve();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
