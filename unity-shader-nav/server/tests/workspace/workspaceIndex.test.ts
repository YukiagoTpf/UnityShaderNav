import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { MacroPatternTable } from '../../src/macros';
import { indexFile } from '../../src/parser/hlsl';
import { WorkspaceIndex } from '../../src/workspace/workspaceIndex';

const fakeConnection = {
  console: { log() {} },
} as never;

function newIndex(): WorkspaceIndex {
  return new WorkspaceIndex(new MacroPatternTable(DEFAULT_SETTINGS.declarationMacros));
}

describe('WorkspaceIndex invariant 1: cache restore order', () => {
  it('restoreFromCache populates store, global, globalRefs and diskIndexes', async () => {
    const wi = newIndex();
    const uri = pathToFileURL('/virtual/Cached.hlsl').href;
    const idx = await indexFile(uri, 'float4 Caller() { return DiskTarget(); }');

    wi.restoreFromCache(uri, idx);

    expect(wi.store.get(uri)).toBe(idx);
    expect(wi.global.lookup('Caller').length).toBeGreaterThanOrEqual(1);
    expect(wi.globalRefs.lookup('DiskTarget').length).toBeGreaterThanOrEqual(1);
    expect(wi.diskIndexEntries()).toContainEqual([uri, idx]);
  });
});

describe('WorkspaceIndex invariant 2: closeDocument fallback', () => {
  it('reverts the live overlay to the on-disk index when a disk index exists', async () => {
    const wi = newIndex();
    const uri = pathToFileURL('/virtual/Common.hlsl').href;
    const diskIdx = await indexFile(uri, 'float4 DiskSym() { return 0; }');

    wi.restoreFromCache(uri, diskIdx);
    await wi.reindex(uri, 'float4 LiveSym() { return 0; }', false);

    // Overlay is live-only while open.
    expect(wi.global.lookup('LiveSym').length).toBeGreaterThanOrEqual(1);
    expect(wi.global.lookup('DiskSym')).toEqual([]);

    wi.closeDocument(uri);

    // Disk index is restored: disk symbol reappears, live-only symbol disappears.
    expect(wi.global.lookup('DiskSym').length).toBeGreaterThanOrEqual(1);
    expect(wi.global.lookup('LiveSym')).toEqual([]);
    expect(wi.store.get(uri)).toBe(diskIdx);
  });

  it('drops the document entirely when there is no on-disk index', async () => {
    const wi = newIndex();
    const uri = pathToFileURL('/virtual/Loose.hlsl').href;

    // Non-standalone reindex never touches diskIndexes, so there is no disk fallback.
    await wi.reindex(uri, 'float4 OnlyLive() { return OnlyRef(); }', false);
    expect(wi.store.get(uri)).toBeDefined();
    expect(wi.global.lookup('OnlyLive').length).toBeGreaterThanOrEqual(1);
    expect(wi.globalRefs.lookup('OnlyRef').length).toBeGreaterThanOrEqual(1);

    wi.closeDocument(uri);

    expect(wi.store.get(uri)).toBeUndefined();
    expect(wi.global.lookup('OnlyLive')).toEqual([]);
    expect(wi.globalRefs.lookup('OnlyRef')).toEqual([]);
  });
});

describe('WorkspaceIndex invariant 3: clear', () => {
  it('clears store, global and diskIndexes', async () => {
    const wi = newIndex();
    const uri = pathToFileURL('/virtual/ToClear.hlsl').href;
    const idx = await indexFile(uri, 'float4 ClearMe() { return 0; }');

    wi.restoreFromCache(uri, idx);
    expect(wi.store.get(uri)).toBeDefined();
    expect(wi.global.lookup('ClearMe').length).toBeGreaterThanOrEqual(1);
    expect(wi.diskIndexEntries().length).toBeGreaterThanOrEqual(1);

    wi.clear();

    expect(wi.store.get(uri)).toBeUndefined();
    expect(wi.global.lookup('ClearMe')).toEqual([]);
    expect(wi.diskIndexEntries()).toEqual([]);
  });
});

describe('WorkspaceIndex invariant 4: persist snapshots diskIndexes not store', () => {
  it('non-standalone reindex sets store but not diskIndexes', async () => {
    const wi = newIndex();
    const uri = pathToFileURL('/virtual/Overlay.hlsl').href;

    await wi.reindex(uri, 'float4 OverlaySym() { return 0; }', false);

    expect(wi.store.get(uri)).toBeDefined();
    expect(wi.diskIndexEntries().map(([entryUri]) => entryUri)).not.toContain(uri);
  });

  it('indexAndStore reads from disk and adds to diskIndexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-wi-disk-'));
    const filePath = join(root, 'Real.hlsl');
    const uri = pathToFileURL(filePath).href;
    await writeFile(filePath, 'float4 RealDiskSym() { return 0; }');

    try {
      const wi = newIndex();
      await wi.indexAndStore(filePath, fakeConnection);

      expect(wi.store.get(uri)).toBeDefined();
      expect(wi.global.lookup('RealDiskSym').length).toBeGreaterThanOrEqual(1);
      expect(wi.diskIndexEntries().map(([entryUri]) => entryUri)).toContain(uri);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('WorkspaceIndex.applyChanges', () => {
  it('drops the uri on a deleted event and indexes a real file on a changed event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-wi-apply-'));
    const deletedPath = join(root, 'Deleted.hlsl');
    const changedPath = join(root, 'Changed.hlsl');
    const deletedUri = pathToFileURL(deletedPath).href;
    const changedUri = pathToFileURL(changedPath).href;
    await writeFile(deletedPath, 'float4 GoneSym() { return 0; }');
    await writeFile(changedPath, 'float4 ChangedSym() { return 0; }');

    try {
      const wi = newIndex();

      // Seed the to-be-deleted file via a disk index, then apply a delete event.
      await wi.indexAndStore(deletedPath, fakeConnection);
      expect(wi.global.lookup('GoneSym').length).toBeGreaterThanOrEqual(1);

      await wi.applyChanges([{ uri: deletedUri, type: 'deleted' }], fakeConnection);
      expect(wi.store.get(deletedUri)).toBeUndefined();
      expect(wi.global.lookup('GoneSym')).toEqual([]);
      expect(wi.diskIndexEntries().map(([entryUri]) => entryUri)).not.toContain(deletedUri);

      // A changed event re-reads the file from disk into store + diskIndexes.
      await wi.applyChanges([{ uri: changedUri, type: 'changed' }], fakeConnection);
      expect(wi.store.get(changedUri)).toBeDefined();
      expect(wi.global.lookup('ChangedSym').length).toBeGreaterThanOrEqual(1);
      expect(wi.diskIndexEntries().map(([entryUri]) => entryUri)).toContain(changedUri);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
