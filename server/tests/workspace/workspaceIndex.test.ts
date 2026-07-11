import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { PackageContext } from '../../src/packages';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import {
  IndexedRevisionBuilder,
  type PublishedIndexedRevision,
} from '../../src/workspace/indexedRevision';

const fakeConnection = {
  console: { log() {}, warn() {} },
} as never;

function newBuilder(root = '/virtual'): IndexedRevisionBuilder {
  return IndexedRevisionBuilder.create({
    folderUri: pathToFileURL(root).href,
    settings: DEFAULT_SETTINGS,
    // These tests model a Unity workspace: live documents are overlays and do
    // not become disk baselines merely because they were indexed.
    unityRoot: root,
    packages: PackageContext.standalone(DEFAULT_SETTINGS),
    cache: undefined,
    fingerprint: undefined,
  });
}

function source(target: string, caller: string): string {
  return [
    `float4 ${target}() { return 0; }`,
    `float4 ${caller}() { return ${target}(); }`,
  ].join('\n');
}

function snapshot(
  uri: string,
  text: string,
  openId = 1,
  version = 1,
): IndexedDocumentSnapshot {
  return { uri, languageId: 'hlsl', text, openId, version };
}

function tokenPosition(
  text: string,
  token: string,
  occurrence: number,
): { line: number; character: number } {
  const lines = text.split(/\r?\n/);
  let remaining = occurrence;
  for (let line = 0; line < lines.length; line++) {
    let from = 0;
    while (from <= lines[line].length) {
      const character = lines[line].indexOf(token, from);
      if (character < 0) break;
      const before = lines[line][character - 1];
      const after = lines[line][character + token.length];
      const isWholeWord = !before?.match(/[A-Za-z0-9_]/)
        && !after?.match(/[A-Za-z0-9_]/);
      if (isWholeWord) {
        if (remaining === 0) return { line, character: character + 1 };
        remaining--;
      }
      from = character + token.length;
    }
  }
  throw new Error(`missing occurrence ${occurrence} of ${token}`);
}

async function commitLive(
  builder: IndexedRevisionBuilder,
  document: IndexedDocumentSnapshot,
): Promise<void> {
  const prepared = await builder.prepareDocument(document, () => true);
  if (!prepared) throw new Error('live document preparation was cancelled');
  expect(builder.commitDocument(document, prepared, () => true)).toBe(true);
}

function documentSymbolNames(
  revision: PublishedIndexedRevision,
  uri: string,
): string[] {
  return revision.documentSymbols({ uri })?.map((symbol) => symbol.name) ?? [];
}

async function expectQueryVisible(
  revision: PublishedIndexedRevision,
  document: IndexedDocumentSnapshot,
  target: string,
  caller: string,
): Promise<void> {
  // documentSymbols observes the effective per-file index (store),
  // workspaceSymbols observes the global symbol projection, and referencesAt
  // observes the global reference projection used by the production handler.
  expect(documentSymbolNames(revision, document.uri)).toEqual(
    expect.arrayContaining([target, caller]),
  );
  expect(revision.workspaceSymbols(target).map((symbol) => symbol.name)).toContain(target);
  await expect(revision.referencesAt({
    document,
    position: tokenPosition(document.text, target, 1),
    includeDeclaration: true,
  })).resolves.toHaveLength(2);
}

async function expectQueryHidden(
  revision: PublishedIndexedRevision,
  document: IndexedDocumentSnapshot,
  target: string,
): Promise<void> {
  expect(documentSymbolNames(revision, document.uri)).not.toContain(target);
  expect(revision.workspaceSymbols(target)).toEqual([]);
  const references = await revision.referencesAt({
    document,
    position: tokenPosition(document.text, target, 1),
    includeDeclaration: true,
  });
  expect(references ?? []).toEqual([]);
}

describe('indexed revision candidate: cache restore', () => {
  it('publishes a cache record consistently to file, symbol, reference, and disk queries', async () => {
    const uri = pathToFileURL('/virtual/Cached.hlsl').href;
    const text = source('DiskTarget', 'CachedCaller');
    const diskIndex = await indexFile(uri, text);
    const builder = newBuilder();

    builder.restoreFromCache(uri, diskIndex);
    const revision = builder.publish(1);

    await expectQueryVisible(revision, snapshot(uri, text), 'DiskTarget', 'CachedCaller');
    expect(revision.diskIndexEntries()).toEqual([[uri, diskIndex]]);
  });
});

describe('indexed revision candidate: close fallback', () => {
  it('replaces a live overlay with its disk baseline in the next publication', async () => {
    const uri = pathToFileURL('/virtual/Common.hlsl').href;
    const diskText = source('DiskTarget', 'DiskCaller');
    const liveText = source('LiveTarget', 'LiveCaller');
    const diskIndex = await indexFile(uri, diskText);
    const liveDocument = snapshot(uri, liveText, 7, 3);
    const builder = newBuilder();

    builder.restoreFromCache(uri, diskIndex);
    await commitLive(builder, liveDocument);
    const liveRevision = builder.publish(1);
    await expectQueryVisible(liveRevision, liveDocument, 'LiveTarget', 'LiveCaller');
    await expectQueryHidden(liveRevision, snapshot(uri, diskText), 'DiskTarget');
    expect(liveRevision.diskIndexEntries()).toEqual([[uri, diskIndex]]);

    const closeCandidate = liveRevision.fork();
    expect(await closeCandidate.closeDocument(uri, liveDocument.openId, () => true)).toBe(true);
    const closedRevision = closeCandidate.publish(2);

    await expectQueryVisible(
      closedRevision,
      snapshot(uri, diskText),
      'DiskTarget',
      'DiskCaller',
    );
    await expectQueryHidden(closedRevision, liveDocument, 'LiveTarget');
    expect(closedRevision.diskIndexEntries()).toEqual([[uri, diskIndex]]);
  });

  it('removes a live-only document from every production query after close', async () => {
    const uri = pathToFileURL('/virtual/Loose.hlsl').href;
    const liveText = source('OnlyLive', 'OnlyLiveCaller');
    const liveDocument = snapshot(uri, liveText, 9, 1);
    const builder = newBuilder();

    await commitLive(builder, liveDocument);
    const liveRevision = builder.publish(1);
    await expectQueryVisible(liveRevision, liveDocument, 'OnlyLive', 'OnlyLiveCaller');
    expect(liveRevision.diskIndexEntries()).toEqual([]);

    const closeCandidate = liveRevision.fork();
    expect(await closeCandidate.closeDocument(uri, liveDocument.openId, () => true)).toBe(true);
    const closedRevision = closeCandidate.publish(2);

    expect(closedRevision.documentSymbols({ uri })).toBeNull();
    await expectQueryHidden(closedRevision, liveDocument, 'OnlyLive');
    expect(closedRevision.diskIndexEntries()).toEqual([]);
  });

  it('does not resurrect a deleted disk baseline through an equivalent drive-letter URI', async () => {
    const openUri = 'file:///C:/Project/Deleted.hlsl';
    const watcherUri = 'file:///c:/Project/Deleted.hlsl';
    const diskText = source('DeletedDisk', 'DeletedDiskCaller');
    const liveText = source('LiveBeforeDelete', 'LiveBeforeDeleteCaller');
    const liveDocument = snapshot(openUri, liveText, 12, 5);
    const builder = newBuilder('/C:/Project');

    builder.restoreFromCache(openUri, await indexFile(openUri, diskText));
    await commitLive(builder, liveDocument);
    expect(await builder.applyChanges(
      [{ uri: watcherUri, type: 'deleted' }],
      fakeConnection,
    )).toBe(true);
    expect(await builder.closeDocument(openUri, liveDocument.openId, () => true)).toBe(true);
    const revision = builder.publish(1);

    expect(revision.diskIndexEntries()).toEqual([]);
    expect(revision.documentSymbols({ uri: openUri })).toBeNull();
    await expectQueryHidden(revision, snapshot(openUri, diskText), 'DeletedDisk');
    await expectQueryHidden(revision, liveDocument, 'LiveBeforeDelete');
  });
});

describe('indexed revision candidate: empty rebuild', () => {
  it('publishes empty replacement state without mutating the previous revision', async () => {
    const uri = pathToFileURL('/virtual/Rebuild.hlsl').href;
    const text = source('BeforeRebuild', 'BeforeRebuildCaller');
    const diskIndex = await indexFile(uri, text);
    const initial = newBuilder();
    initial.restoreFromCache(uri, diskIndex);
    const previous = initial.publish(1);

    const replacement = newBuilder().publish(2);

    await expectQueryVisible(
      previous,
      snapshot(uri, text),
      'BeforeRebuild',
      'BeforeRebuildCaller',
    );
    expect(previous.diskIndexEntries()).toEqual([[uri, diskIndex]]);
    expect(replacement.documentSymbols({ uri })).toBeNull();
    await expectQueryHidden(replacement, snapshot(uri, text), 'BeforeRebuild');
    expect(replacement.diskIndexEntries()).toEqual([]);
  });
});

describe('indexed revision candidate: disk and live persistence', () => {
  it('publishes a live Unity overlay without adding it to the disk snapshot', async () => {
    const uri = pathToFileURL('/virtual/Overlay.hlsl').href;
    const text = source('OverlayTarget', 'OverlayCaller');
    const document = snapshot(uri, text, 15, 2);
    const builder = newBuilder();

    await commitLive(builder, document);
    const revision = builder.publish(1);

    await expectQueryVisible(revision, document, 'OverlayTarget', 'OverlayCaller');
    expect(revision.diskIndexEntries()).toEqual([]);
  });

  it('indexes a real file into both production queries and the disk snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-wi-disk-'));
    const filePath = join(root, 'Real.hlsl');
    const uri = pathToFileURL(filePath).href;
    const text = source('RealDiskTarget', 'RealDiskCaller');
    await writeFile(filePath, text);

    try {
      const builder = newBuilder(root);
      expect(await builder.indexAndStore(filePath, fakeConnection)).toBe(true);
      const revision = builder.publish(1);

      await expectQueryVisible(
        revision,
        snapshot(uri, text),
        'RealDiskTarget',
        'RealDiskCaller',
      );
      expect(revision.diskIndexEntries().map(([entryUri]) => entryUri)).toContain(uri);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('indexed revision candidate: file events', () => {
  it('deletes one disk file and publishes a changed disk file without leaking stale queries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-wi-apply-'));
    const deletedPath = join(root, 'Deleted.hlsl');
    const changedPath = join(root, 'Changed.hlsl');
    const deletedUri = pathToFileURL(deletedPath).href;
    const changedUri = pathToFileURL(changedPath).href;
    const deletedText = source('GoneTarget', 'GoneCaller');
    const changedText = source('ChangedTarget', 'ChangedCaller');
    await writeFile(deletedPath, deletedText);
    await writeFile(changedPath, changedText);

    try {
      const initial = newBuilder(root);
      expect(await initial.indexAndStore(deletedPath, fakeConnection)).toBe(true);
      const beforeEvents = initial.publish(1);
      await expectQueryVisible(
        beforeEvents,
        snapshot(deletedUri, deletedText),
        'GoneTarget',
        'GoneCaller',
      );

      const deleteCandidate = beforeEvents.fork();
      expect(await deleteCandidate.applyChanges(
        [{ uri: deletedUri, type: 'deleted' }],
        fakeConnection,
      )).toBe(true);
      const afterDelete = deleteCandidate.publish(2);
      expect(afterDelete.documentSymbols({ uri: deletedUri })).toBeNull();
      await expectQueryHidden(
        afterDelete,
        snapshot(deletedUri, deletedText),
        'GoneTarget',
      );
      expect(afterDelete.diskIndexEntries().map(([entryUri]) => entryUri))
        .not.toContain(deletedUri);

      const changeCandidate = afterDelete.fork();
      expect(await changeCandidate.applyChanges(
        [{ uri: changedUri, type: 'changed' }],
        fakeConnection,
      )).toBe(true);
      const afterChange = changeCandidate.publish(3);
      await expectQueryVisible(
        afterChange,
        snapshot(changedUri, changedText),
        'ChangedTarget',
        'ChangedCaller',
      );
      expect(afterChange.diskIndexEntries().map(([entryUri]) => entryUri))
        .toContain(changedUri);
      expect(beforeEvents.workspaceSymbols('GoneTarget')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
