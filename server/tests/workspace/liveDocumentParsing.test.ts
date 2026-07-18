import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it, vi } from 'vitest';
import { LiveDocumentTreeSession } from '../../src/parser/hlsl/liveDocumentTreeSession';
import {
  createHlslParser,
  type ReusableHlslParser,
} from '../../src/parser/hlsl/parser';
import { uriKey } from '../../src/uriKey';
import { Workspace } from '../../src/workspace/workspace';

const connection = {
  console: { log() {}, warn() {}, error() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

describe('Workspace live-document parsing', () => {
  it('reuses one tree session across accepted versions of the same open document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-tree-session-'));
    const uri = pathToFileURL(join(root, 'Live.hlsl')).href;
    const parser = await createHlslParser();
    const parse = vi.fn(parser.parseStabilized.bind(parser));
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      releaseVersion: null,
      createLiveDocumentTreeSession: () => new LiveDocumentTreeSession(async () => ({
        parseStabilized: parse,
        delete: parser.delete.bind(parser),
      } satisfies ReusableHlslParser)),
    });

    try {
      await workspace.initialize(connection);
      await workspace.updateDocument({
        uri,
        languageId: 'hlsl',
        text: 'float4 FirstLive() { return 0; }',
        openId: 1,
        version: 1,
      });
      await workspace.updateDocument({
        uri,
        languageId: 'hlsl',
        text: 'float4 SecondLive() { return 0; }',
        openId: 1,
        version: 2,
      });

      expect(parse).toHaveBeenCalledTimes(2);
      expect(parse.mock.calls[0][1]).toBeUndefined();
      expect(parse.mock.calls[1][1]).toBeDefined();
      expect(workspace.workspaceSymbols('FirstLive')).toEqual([]);
      expect(workspace.workspaceSymbols('SecondLive')).toHaveLength(1);
    } finally {
      workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retires one URI/openId generation on close and creates a fresh generation on reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-tree-reopen-'));
    const uri = pathToFileURL(join(root, 'Reopen.hlsl')).href;
    const identities: Array<{ uriKey: string; openId: number; generation: number }> = [];
    const disposals: Array<ReturnType<typeof vi.fn>> = [];
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      releaseVersion: null,
      createLiveDocumentTreeSession(identity) {
        identities.push(identity);
        const session = new LiveDocumentTreeSession();
        const dispose = vi.fn(session.dispose.bind(session));
        session.dispose = dispose;
        disposals.push(dispose);
        return session;
      },
    });

    try {
      await workspace.initialize(connection);
      await workspace.updateDocument({
        uri,
        languageId: 'hlsl',
        text: 'float4 FirstSession() { return 0; }',
        openId: 1,
        version: 1,
      });
      await workspace.closeDocument({ uri, openId: 1 });
      expect(disposals[0]).toHaveBeenCalledTimes(1);

      await workspace.updateDocument({
        uri,
        languageId: 'hlsl',
        text: 'float4 ReopenedSession() { return 0; }',
        openId: 2,
        version: 1,
      });

      expect(identities).toEqual([
        { uriKey: uriKey(uri), openId: 1, generation: 1 },
        { uriKey: uriKey(uri), openId: 2, generation: 2 },
      ]);
      expect(disposals[1]).not.toHaveBeenCalled();
      expect(workspace.workspaceSymbols('FirstSession')).toEqual([]);
      expect(workspace.workspaceSymbols('ReopenedSession')).toHaveLength(1);
    } finally {
      workspace.dispose();
      expect(disposals[1]).toHaveBeenCalledTimes(1);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases a live tree session when open-document ownership moves away', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-tree-ownership-'));
    const uri = pathToFileURL(join(root, 'Transferred.hlsl')).href;
    const document = snapshot(uri, 'float4 TransferredLive() { return 0; }', 1);
    const disposeSession = vi.fn();
    let openDocuments: ReturnType<typeof snapshot>[] = [];
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      releaseVersion: null,
      openDocuments: () => openDocuments,
      createLiveDocumentTreeSession() {
        const session = new LiveDocumentTreeSession();
        const dispose = session.dispose.bind(session);
        session.dispose = () => {
          disposeSession();
          dispose();
        };
        return session;
      },
    });

    try {
      await workspace.initialize(connection);
      openDocuments = [document];
      await expect(workspace.updateDocument(document)).resolves.toBe(true);
      expect(disposeSession).not.toHaveBeenCalled();

      openDocuments = [];
      await workspace.synchronizeOpenDocuments();

      expect(disposeSession).toHaveBeenCalledTimes(1);
      expect(workspace.workspaceSymbols('TransferredLive')).toEqual([]);
    } finally {
      workspace.dispose();
      expect(disposeSession).toHaveBeenCalledTimes(1);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cannot retain a late tree from a closed generation after the URI reopens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-tree-late-reopen-'));
    const uri = pathToFileURL(join(root, 'LateReopen.hlsl')).href;
    const parserStarted = deferred<void>();
    const parserReady = deferred<ReusableHlslParser>();
    const oldParser = await createHlslParser();
    const oldParse = vi.fn(oldParser.parseStabilized.bind(oldParser));
    const oldDelete = vi.fn(oldParser.delete.bind(oldParser));
    const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
      releaseVersion: null,
      createLiveDocumentTreeSession(identity) {
        if (identity.generation !== 1) return new LiveDocumentTreeSession();
        return new LiveDocumentTreeSession(async () => {
          parserStarted.resolve(undefined);
          return parserReady.promise;
        });
      },
    });
    const first = {
      uri,
      languageId: 'hlsl',
      text: 'float4 ClosedBeforeParse() { return 0; }',
      openId: 1,
      version: 1,
    };
    const reopened = {
      uri,
      languageId: 'hlsl',
      text: 'float4 CurrentGeneration() { return 0; }',
      openId: 2,
      version: 1,
    };

    try {
      await workspace.initialize(connection);
      const staleUpdate = workspace.updateDocument(first);
      await parserStarted.promise;
      const closing = workspace.closeDocument({ uri, openId: 1 });
      const currentUpdate = workspace.updateDocument(reopened);
      parserReady.resolve({
        parseStabilized: oldParse,
        delete: oldDelete,
      });

      await expect(staleUpdate).resolves.toBe(false);
      await expect(closing).resolves.toBeUndefined();
      await expect(currentUpdate).resolves.toBe(true);
      expect(oldParse).not.toHaveBeenCalled();
      expect(oldDelete).toHaveBeenCalledTimes(1);
      expect(workspace.workspaceSymbols('ClosedBeforeParse')).toEqual([]);
      expect(workspace.workspaceSymbols('CurrentGeneration')).toHaveLength(1);
    } finally {
      parserReady.resolve({
        parseStabilized: oldParse,
        delete: oldDelete,
      });
      workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not enqueue an older replay snapshot after a newer live version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-tree-replay-order-'));
    const folderUri = pathToFileURL(root).href;
    const blockerUri = pathToFileURL(join(root, 'Blocker.hlsl')).href;
    const targetUri = pathToFileURL(join(root, 'Target.hlsl')).href;
    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const targetParses: string[] = [];
    const oldTarget = 'float4 OldReplayTarget() { return 0; }';
    const newTarget = 'float4 NewLiveTarget() { return 0; }';
    let openDocuments: ReturnType<typeof snapshot>[] = [];
    const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, {
      releaseVersion: null,
      openDocuments: () => openDocuments,
      createLiveDocumentTreeSession(identity) {
        if (identity.uriKey === uriKey(blockerUri)) {
          return new LiveDocumentTreeSession(async () => {
            blockerStarted.resolve(undefined);
            await releaseBlocker.promise;
            return createHlslParser();
          });
        }
        return new LiveDocumentTreeSession(async () => {
          const parser = await createHlslParser();
          return {
            parseStabilized(text, oldTree) {
              targetParses.push(text);
              return parser.parseStabilized(text, oldTree);
            },
            delete: parser.delete.bind(parser),
          };
        });
      },
    });
    let rebuilding: Promise<void> | undefined;

    try {
      await workspace.initialize(connection);
      openDocuments = [
        snapshot(blockerUri, 'float4 BlockReplay() { return 0; }', 1),
        snapshot(targetUri, oldTarget, 1),
      ];
      rebuilding = workspace.rebuild(connection);
      await blockerStarted.promise;

      const latest = snapshot(targetUri, newTarget, 2);
      openDocuments = [openDocuments[0], latest];
      await expect(workspace.updateDocument(latest)).resolves.toBe(true);

      releaseBlocker.resolve(undefined);
      await rebuilding;

      expect(targetParses).toEqual([newTarget]);
      expect(workspace.workspaceSymbols('OldReplayTarget')).toEqual([]);
      expect(workspace.workspaceSymbols('NewLiveTarget')).toHaveLength(1);
    } finally {
      releaseBlocker.resolve(undefined);
      await Promise.allSettled([rebuilding ?? Promise.resolve()]);
      workspace.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not retire a reopened session for an older blocked replay snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-tree-stale-replay-session-'));
    const folderUri = pathToFileURL(root).href;
    const blockerUri = pathToFileURL(join(root, 'Blocker.hlsl')).href;
    const targetUri = pathToFileURL(join(root, 'Reopened.hlsl')).href;
    const blocker = snapshot(blockerUri, 'float4 BlockStaleReplay() { return 0; }', 1);
    const oldTarget = snapshot(targetUri, 'float4 OldOpenSession() { return 0; }', 1);
    const reopened = {
      ...snapshot(targetUri, 'float4 ReopenedCurrentSession() { return 0; }', 1),
      openId: 2,
    };
    const blockerStarted = deferred<void>();
    const releaseBlocker = deferred<void>();
    const targetIdentities: Array<{ uriKey: string; openId: number; generation: number }> = [];
    const targetDisposals: Array<ReturnType<typeof vi.fn>> = [];
    let openDocuments: ReturnType<typeof snapshot>[] = [];
    const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, {
      releaseVersion: null,
      openDocuments: () => openDocuments,
      createLiveDocumentTreeSession(identity) {
        if (identity.uriKey === uriKey(blockerUri)) {
          return new LiveDocumentTreeSession(async () => {
            blockerStarted.resolve(undefined);
            await releaseBlocker.promise;
            return createHlslParser();
          });
        }
        targetIdentities.push(identity);
        const session = new LiveDocumentTreeSession();
        const dispose = vi.fn(session.dispose.bind(session));
        session.dispose = dispose;
        targetDisposals.push(dispose);
        return session;
      },
    });
    let rebuilding: Promise<void> | undefined;

    try {
      await workspace.initialize(connection);
      openDocuments = [blocker, oldTarget];
      rebuilding = workspace.rebuild(connection);
      await blockerStarted.promise;

      openDocuments = [blocker];
      await workspace.closeDocument({ uri: targetUri, openId: 1 });
      openDocuments = [blocker, reopened];
      await expect(workspace.updateDocument(reopened)).resolves.toBe(true);
      expect(targetIdentities.map((identity) => identity.openId)).toEqual([2]);
      expect(targetDisposals[0]).not.toHaveBeenCalled();

      releaseBlocker.resolve(undefined);
      await rebuilding;

      expect(targetIdentities.map((identity) => identity.openId)).toEqual([2]);
      expect(targetDisposals[0]).not.toHaveBeenCalled();
      expect(workspace.workspaceSymbols('OldOpenSession')).toEqual([]);
      expect(workspace.workspaceSymbols('ReopenedCurrentSession')).toHaveLength(1);
    } finally {
      releaseBlocker.resolve(undefined);
      await Promise.allSettled([rebuilding ?? Promise.resolve()]);
      workspace.dispose();
      expect(targetDisposals[0]).toHaveBeenCalledTimes(1);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function snapshot(uri: string, text: string, version: number) {
  return { uri, text, version, openId: 1, languageId: 'hlsl' };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
