import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import { Workspace } from '../../src/workspace/workspace';

const fakeConnection = {
  console: { log() {}, warn() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

function snapshot(
  uri: string,
  text: string,
  openId: number,
  version: number,
  languageId = 'hlsl',
): IndexedDocumentSnapshot {
  return { uri, languageId, text, openId, version };
}

function positionOf(text: string, token: string, occurrence = 0) {
  let offset = 0;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(token, offset);
    if (offset < 0) throw new Error(`missing token ${token}`);
    if (index < occurrence) offset += token.length;
  }
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Indexed Workspace live-document behavior', () => {
  it('preserves lexical completion and signature early exits without indexing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-lexical-exit-'));
    const uri = pathToFileURL(join(root, 'Lexical.hlsl')).href;
    let parseCalls = 0;
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        async indexDocument() {
          parseCalls++;
          throw new Error('lexical early exit must not index');
        },
      });
      await workspace.initialize(fakeConnection);
      const text = '// comment completion';
      const document = snapshot(uri, text, 1, 1);

      await expect(workspace.completionAt({
        document,
        position: { line: 0, character: text.length },
      })).resolves.toEqual([]);
      await expect(workspace.signatureHelpAt({
        document,
        position: { line: 0, character: text.length },
      })).resolves.toBeNull();

      expect(parseCalls).toBe(0);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 1,
        warningCount: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates Definition and Find References from the same unsaved snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-live-'));
    const uri = pathToFileURL(join(root, 'Live.hlsl')).href;
    const v1 = [
      'float4 OldTarget() { return 0; }',
      'float4 Caller() { return OldTarget(); }',
    ].join('\n');
    const v2 = [
      'float4 NewTarget() { return 0; }',
      'float4 Caller() { return NewTarget(); }',
    ].join('\n');

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
      });
      await workspace.initialize(fakeConnection);

      const first = snapshot(uri, v1, 1, 1);
      await workspace.updateDocument(first);
      const oldDefinition = await workspace.definitionAt({
        document: first,
        position: positionOf(v1, 'OldTarget', 1),
      });
      const oldReferences = await workspace.referencesAt({
        document: first,
        position: positionOf(v1, 'OldTarget'),
        includeDeclaration: true,
      });
      expect(oldDefinition).toHaveLength(1);
      expect(oldReferences).toHaveLength(2);

      const second = snapshot(uri, v2, 1, 2);
      await workspace.updateDocument(second);
      const newDefinition = await workspace.definitionAt({
        document: second,
        position: positionOf(v2, 'NewTarget', 1),
      });
      const newReferences = await workspace.referencesAt({
        document: second,
        position: positionOf(v2, 'NewTarget'),
        includeDeclaration: true,
      });
      expect(newDefinition).toHaveLength(1);
      expect(newReferences).toHaveLength(2);
      expect(newDefinition?.[0]).toMatchObject({ targetUri: uri });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('close replaces a committed live overlay with the distinct disk baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-close-'));
    const targetPath = join(root, 'Target.hlsl');
    const targetUri = pathToFileURL(targetPath).href;
    const callerUri = pathToFileURL(join(root, 'Caller.hlsl')).href;
    const savedText = 'float4 SavedTarget() { return 0; }';
    const liveText = 'float4 LiveTarget() { return 0; }';
    const callerText = [
      '#include "Target.hlsl"',
      'float4 Caller() { return LiveTarget() + SavedTarget(); }',
    ].join('\n');
    await writeFile(targetPath, savedText);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
      });
      await workspace.initialize(fakeConnection);
      const target = snapshot(targetUri, liveText, 1, 1);
      const caller = snapshot(callerUri, callerText, 2, 1);
      await workspace.updateDocument(target);
      await workspace.updateDocument(caller);
      expect(await workspace.definitionAt({
        document: caller,
        position: positionOf(callerText, 'LiveTarget'),
      })).toHaveLength(1);
      expect(workspace.workspaceSymbols('SavedTarget')).toEqual([]);

      await workspace.closeDocument({ uri: targetUri, openId: 1 });
      expect(workspace.workspaceSymbols('LiveTarget')).toEqual([]);
      expect(await workspace.definitionAt({
        document: caller,
        position: positionOf(callerText, 'SavedTarget'),
      })).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('close removes a committed live-only file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-live-only-close-'));
    const targetUri = pathToFileURL(join(root, 'Ephemeral.hlsl')).href;
    const liveText = 'float4 EphemeralTarget() { return 0; }';
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
      });
      await workspace.initialize(fakeConnection);
      await workspace.updateDocument(snapshot(targetUri, liveText, 1, 1));
      expect(workspace.workspaceSymbols('EphemeralTarget')).toHaveLength(1);

      await workspace.closeDocument({ uri: targetUri, openId: 1 });
      expect(workspace.workspaceSymbols('EphemeralTarget')).toEqual([]);
      await expect(workspace.documentSymbols({ uri: targetUri })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('coalesces a newer version while the same open session is parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-version-race-'));
    const uri = pathToFileURL(join(root, 'VersionRace.hlsl')).href;
    const staleStarted = deferred();
    const releaseStale = deferred();
    const staleText = 'float4 StaleVersion() { return 0; }';
    const freshText = 'float4 FreshVersion() { return 0; }';
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        async indexDocument(indexUri, text, table) {
          if (text === staleText) {
            staleStarted.resolve();
            await releaseStale.promise;
          }
          return indexFile(indexUri, text, table);
        },
      });
      await workspace.initialize(fakeConnection);

      const stale = workspace.updateDocument(snapshot(uri, staleText, 1, 1));
      await staleStarted.promise;
      const fresh = workspace.updateDocument(snapshot(uri, freshText, 1, 2));
      releaseStale.resolve();

      await expect(stale).resolves.toBe(false);
      await expect(fresh).resolves.toBe(true);
      expect(workspace.workspaceSymbols('StaleVersion')).toEqual([]);
      expect(workspace.workspaceSymbols('FreshVersion')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases a settled URI slot before a dependent query can reuse it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-slot-release-'));
    const uri = pathToFileURL(join(root, 'SlotRelease.hlsl')).href;
    const first = snapshot(uri, 'float4 FirstVersion() { return 0; }', 1, 1);
    const secondText = [
      'float4 SecondVersion() { return 0; }',
      'float4 Caller() { return SecondVersion(); }',
    ].join('\n');
    const second = snapshot(uri, secondText, 1, 2);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
      });
      await workspace.initialize(fakeConnection);

      type ReconcileInternal = {
        performDocumentReconcile(
          key: string,
          allowBeforePublish?: boolean,
          releaseRun?: () => void,
        ): Promise<void>;
      };
      const internal = workspace as unknown as ReconcileInternal;
      const reconcile = internal.performDocumentReconcile.bind(internal);
      let injectDependentQuery = true;
      let dependentQuery: ReturnType<Workspace['definitionAt']> | undefined;
      internal.performDocumentReconcile = async (...args) => {
        await reconcile(...args);
        if (!injectDependentQuery) return;
        injectDependentQuery = false;
        // This executes after the worker's final needs-check but before its
        // outer operation promise settles. Reusing the old run here used to
        // place its retry behind the query that awaited that retry.
        dependentQuery = workspace.definitionAt({
          document: second,
          position: positionOf(secondText, 'SecondVersion', 1),
        });
      };

      await expect(workspace.updateDocument(first)).resolves.toBe(false);
      expect(dependentQuery).toBeDefined();
      await expect(dependentQuery!).resolves.toHaveLength(1);
      expect(workspace.workspaceSymbols('FirstVersion')).toEqual([]);
      expect(workspace.workspaceSymbols('SecondVersion')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a stale parse after close/reopen at the same version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-race-'));
    const uri = pathToFileURL(join(root, 'Race.hlsl')).href;
    const staleStarted = deferred();
    const releaseStale = deferred();
    const staleText = 'float4 Stale() { return 0; }';
    const freshText = 'float4 Fresh() { return 0; }';

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        async indexDocument(indexUri, text, table) {
          if (text.includes('Stale')) {
            staleStarted.resolve();
            await releaseStale.promise;
          }
          return indexFile(indexUri, text, table);
        },
      });
      await workspace.initialize(fakeConnection);

      const stale = snapshot(uri, staleText, 1, 1);
      const staleUpdate = workspace.updateDocument(stale);
      await staleStarted.promise;
      const closing = workspace.closeDocument({ uri, openId: 1 });
      const fresh = snapshot(uri, freshText, 2, 1);
      const freshUpdate = workspace.updateDocument(fresh);
      releaseStale.resolve();

      expect(await staleUpdate).toBe(false);
      expect(await closing).toBeUndefined();
      expect(await freshUpdate).toBe(true);
      expect(await workspace.definitionAt({
        document: fresh,
        position: positionOf(freshText, 'Fresh'),
      })).toHaveLength(1);
      expect(workspace.workspaceSymbols('Stale')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a live commit when close arrives during standalone disk preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-disk-race-'));
    const path = join(root, 'DiskRace.hlsl');
    const uri = pathToFileURL(path).href;
    const savedText = 'float4 SavedAfterClose() { return 0; }';
    const liveText = 'float4 LiveBeforeClose() { return 0; }';
    await writeFile(path, savedText);
    const diskParseStarted = deferred();
    const releaseDiskParse = deferred();
    let blocked = false;

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        async indexDocument(indexUri, text, table) {
          if (text === savedText && !blocked) {
            blocked = true;
            diskParseStarted.resolve();
            await releaseDiskParse.promise;
          }
          return indexFile(indexUri, text, table);
        },
      });
      await workspace.initialize(fakeConnection);

      const live = snapshot(uri, liveText, 1, 1);
      const updating = workspace.updateDocument(live);
      await diskParseStarted.promise;
      const closing = workspace.closeDocument({ uri, openId: 1 });
      releaseDiskParse.resolve();

      await expect(updating).resolves.toBe(false);
      await expect(closing).resolves.toBeUndefined();
      expect(workspace.workspaceSymbols('LiveBeforeClose')).toEqual([]);
      expect(workspace.workspaceSymbols('SavedAfterClose')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects parser failures and publishes a failed lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-failure-'));
    const uri = pathToFileURL(join(root, 'Broken.hlsl')).href;
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        async indexDocument() {
          throw new Error('document parser failed');
        },
      });
      await workspace.initialize(fakeConnection);

      await expect(workspace.updateDocument(
        snapshot(uri, 'float4 Broken() { return 0; }', 1, 1),
      )).rejects.toThrow('document parser failed');
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'failed',
        servingRevision: 1,
        failure: { category: 'indexing', message: 'document parser failed' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays the latest provider snapshot before publishing ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-provider-'));
    const uri = pathToFileURL(join(root, 'Provider.hlsl')).href;
    const text = [
      'float4 UnsavedProvider() { return 0; }',
      'float4 Caller() { return UnsavedProvider(); }',
    ].join('\n');
    const document = snapshot(uri, text, 1, 7);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        openDocuments: () => [document],
      });
      await workspace.initialize(fakeConnection);

      expect(workspace.indexStatus().lifecycle).toMatchObject({ state: 'ready' });
      expect(await workspace.definitionAt({
        document,
        position: positionOf(text, 'UnsavedProvider', 1),
      })).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes a caller query behind a previously accepted declaration edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-barrier-'));
    const targetUri = pathToFileURL(join(root, 'Target.hlsl')).href;
    const callerUri = pathToFileURL(join(root, 'Caller.hlsl')).href;
    const targetText = 'float4 EditedTarget() { return 0; }';
    const callerText = '#include "Target.hlsl"\nfloat4 Caller() { return EditedTarget(); }';
    const editStarted = deferred();
    const releaseEdit = deferred();
    await writeFile(join(root, 'Target.hlsl'), targetText);

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        async indexDocument(uri, text, table) {
          if (uri === targetUri) {
            editStarted.resolve();
            await releaseEdit.promise;
          }
          return indexFile(uri, text, table);
        },
      });
      await workspace.initialize(fakeConnection);
      const target = snapshot(targetUri, targetText, 1, 1);
      const caller = snapshot(callerUri, callerText, 2, 1);
      const editing = workspace.updateDocument(target);
      await editStarted.promise;
      const definition = workspace.definitionAt({
        document: caller,
        position: positionOf(callerText, 'EditedTarget'),
      });
      releaseEdit.resolve();

      await expect(editing).resolves.toBe(true);
      await expect(definition).resolves.toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('republishes a live overlay when a watcher uses different drive-letter casing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-uri-key-'));
    const openUri = 'file:///C:/Project/Case.hlsl';
    const watcherUri = 'file:///c:/Project/Case.hlsl';
    const text = 'float4 LiveAcrossWatcher() { return 0; }';
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
      });
      await workspace.initialize(fakeConnection);
      await workspace.updateDocument(snapshot(openUri, text, 1, 1));

      await workspace.applyChanges(
        [{ uri: watcherUri, type: 'deleted' }],
        fakeConnection,
      );

      expect(workspace.workspaceSymbols('LiveAcrossWatcher')).toHaveLength(1);
      await expect(workspace.documentSymbols({ uri: watcherUri })).resolves.not.toBeNull();

      await workspace.closeDocument({ uri: openUri, openId: 1 });
      expect(workspace.workspaceSymbols('LiveAcrossWatcher')).toEqual([]);
      await expect(workspace.documentSymbols({ uri: watcherUri })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves include Definition without parsing the request document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-include-'));
    const includePath = join(root, 'Common.hlsl');
    const callerUri = pathToFileURL(join(root, 'Caller.hlsl')).href;
    const text = '#include "Common.hlsl"';
    await writeFile(includePath, 'float4 Included() { return 0; }');
    let parseCalls = 0;
    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        ensureParserReady: async () => {},
        async indexDocument() {
          parseCalls++;
          throw new Error('request document should not be parsed');
        },
      });
      await workspace.initialize(fakeConnection);

      const result = await workspace.definitionAt({
        document: snapshot(callerUri, text, 1, 1),
        position: { line: 0, character: 12 },
      });

      expect(result).toMatchObject([{ targetUri: pathToFileURL(includePath).href }]);
      expect(parseCalls).toBe(0);
      expect(workspace.indexStatus().lifecycle).toMatchObject({ state: 'ready' });

      const failingUpdate = workspace.updateDocument(snapshot(
        callerUri,
        'float4 BrokenDocument() { return 0; }',
        1,
        2,
      ));
      const queuedInclude = workspace.definitionAt({
        document: snapshot(callerUri, text, 1, 1),
        position: { line: 0, character: 12 },
      });
      await expect(failingUpdate).rejects.toThrow('request document should not be parsed');
      await expect(queuedInclude).resolves.toHaveLength(1);
      expect(parseCalls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discards an include Definition when the Workspace retires during resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-indexed-workspace-include-retire-'));
    const includePath = join(root, 'Common.hlsl');
    const callerUri = pathToFileURL(join(root, 'Caller.hlsl')).href;
    const text = '#include "Common.hlsl"';
    await writeFile(includePath, 'float4 Included() { return 0; }');
    try {
      const workspace = new Workspace(
        pathToFileURL(root).href,
        {
          ...DEFAULT_SETTINGS,
          debug: { ...DEFAULT_SETTINGS.debug, definitionTrace: true },
        },
        { ensureParserReady: async () => {} },
      );
      await workspace.initialize(fakeConnection);

      const result = await workspace.definitionAt({
        document: snapshot(callerUri, text, 1, 1),
        position: { line: 0, character: 12 },
        observer: {
          trace(event) {
            if (event === 'include') workspace.dispose();
          },
        },
      });

      expect(result).toBeNull();
      expect(workspace.canServe()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
