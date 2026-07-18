import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { PackageContext } from '../../src/packages';
import { indexFile } from '../../src/parser/hlsl';
import { IndexedRevisionBuilder } from '../../src/workspace/indexedRevision';
import { createTestWorkspaceLocation } from '../helpers/testWorkspaceLocation';

const workspaceLocation = createTestWorkspaceLocation('usn-indexed-revision');

const fakeConnection = {
  console: { log() {}, warn() {} },
} as never;

describe('PublishedIndexedRevision', () => {
  it('keeps the published index isolated from a forked candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-revision-isolation-'));
    const filePath = join(root, 'Atomic.hlsl');
    const fileUri = pathToFileURL(filePath).href;
    try {
      await writeFile(filePath, 'float4 OldRevision() { return 0; }');
      const initial = IndexedRevisionBuilder.create({
        folderUri: pathToFileURL(root).href,
        settings: DEFAULT_SETTINGS,
        unityRoot: undefined,
        packages: PackageContext.standalone(DEFAULT_SETTINGS),
        cache: undefined,
        fingerprint: undefined,
      });
      await initial.indexAndStore(filePath, fakeConnection);
      const published = initial.publish(1);

      const candidate = published.fork();
      await writeFile(filePath, 'float4 NewRevision() { return 0; }');
      await candidate.applyChanges(
        [{ uri: fileUri, type: 'changed' }],
        fakeConnection,
      );

      expect(published.workspaceSymbols('OldRevision')).toHaveLength(1);
      expect(published.workspaceSymbols('NewRevision')).toEqual([]);

      const next = candidate.publish(2);
      expect(next.workspaceSymbols('OldRevision')).toEqual([]);
      expect(next.workspaceSymbols('NewRevision')).toHaveLength(1);
      expect(published.workspaceSymbols('OldRevision')).toHaveLength(1);
      expect(() => candidate.publish(3)).toThrow(/already published/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('snapshots and freezes settings with the revision', () => {
    const mutable = {
      ...DEFAULT_SETTINGS,
      includeDirectories: ['Includes'],
      findReferences: { includePackages: true },
    };
    const revision = IndexedRevisionBuilder.create({
      folderUri: workspaceLocation.folderUri,
      settings: mutable,
      unityRoot: undefined,
      packages: PackageContext.standalone(mutable),
      cache: undefined,
      fingerprint: undefined,
    }).publish(1);

    mutable.includeDirectories.push('Later');
    mutable.findReferences.includePackages = false;
    expect(revision.settings.includeDirectories).toEqual(['Includes']);
    expect(revision.settings.findReferences.includePackages).toBe(true);
    expect(Object.isFrozen(revision.settings.includeDirectories)).toBe(true);
    expect(revision.packages.includeCtx.includeDirectories).toEqual(['Includes']);
    expect(Object.isFrozen(revision.packages.includeCtx.includeDirectories)).toBe(true);
  });

  it('freezes the FileIndex shell before candidate forks share readonly facts', async () => {
    const uri = workspaceLocation.fileUri('Frozen.hlsl');
    const index = await indexFile(uri, 'float4 FrozenSymbol() { return 0; }');
    const builder = IndexedRevisionBuilder.create({
      folderUri: workspaceLocation.folderUri,
      settings: DEFAULT_SETTINGS,
      unityRoot: undefined,
      packages: PackageContext.standalone(DEFAULT_SETTINGS),
      cache: undefined,
      fingerprint: undefined,
    });
    builder.restoreFromCache(uri, index);
    const revision = builder.publish(1);
    const stored = revision.diskIndexEntries()[0][1];

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.symbols)).toBe(false);
    expect(Object.isFrozen(stored.symbols[0])).toBe(false);
    expect(revision.workspaceSymbols('FrozenSymbol')).toHaveLength(1);
    expect(revision.fork().publish(2).workspaceSymbols('FrozenSymbol')).toHaveLength(1);
  });
});
