import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { indexFile } from '../../src/parser/hlsl';
import type { IndexedDocumentSnapshot } from '../../src/workspace/indexedWorkspace';
import {
  DefaultIndexedRevisionCandidateConstructor,
  type IndexedRevisionCandidateConstructor,
} from '../../src/workspace/indexedRevisionCandidate';
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

describe('live document publication during rebuild', () => {
  it('answers an edited-document query before the rebuild candidate completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-during-rebuild-'));
    const uri = pathToFileURL(join(root, 'Live.hlsl')).href;
    const text = [
      'float4 DuringRebuild() { return 0; }',
      'float4 Caller() { return DuringRebuild(); }',
    ].join('\n');
    const document: IndexedDocumentSnapshot = {
      uri,
      languageId: 'hlsl',
      text,
      openId: 1,
      version: 1,
    };
    const rebuildStarted = deferred();
    const releaseRebuild = deferred();
    let parserReadinessAttempts = 0;
    let openDocuments: readonly IndexedDocumentSnapshot[] = [];
    let rebuilding: Promise<void> | undefined;
    let definition: ReturnType<Workspace['definitionAt']> | undefined;

    try {
      const workspace = new Workspace(pathToFileURL(root).href, DEFAULT_SETTINGS, {
        releaseVersion: null,
        openDocuments: () => openDocuments,
        async ensureParserReady() {
          parserReadinessAttempts++;
          if (parserReadinessAttempts === 2) {
            rebuildStarted.resolve();
            await releaseRebuild.promise;
          }
        },
        indexDocument: indexFile,
      });
      await workspace.initialize(connection);

      rebuilding = workspace.rebuild(connection);
      await rebuildStarted.promise;
      openDocuments = [document];
      definition = workspace.definitionAt({
        document,
        position: positionOf(text, 'DuringRebuild', 1),
      });

      await expect(settlesBefore(definition, 1_000)).resolves.toHaveLength(1);
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'indexing',
        operation: 'rebuild',
        servingRevision: 2,
      });

      releaseRebuild.resolve();
      await rebuilding;
      expect(workspace.indexStatus().lifecycle).toEqual({
        state: 'ready',
        revision: 3,
        warningCount: 0,
      });
      expect(workspace.workspaceSymbols('DuringRebuild')).toHaveLength(1);
    } finally {
      releaseRebuild.resolve();
      await Promise.allSettled([
        rebuilding ?? Promise.resolve(),
        definition ?? Promise.resolve(),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'live-only document', diskText: undefined, expectedDiskSymbol: undefined },
    {
      name: 'document with a disk baseline',
      diskText: 'float4 SavedBaseline() { return 0; }',
      expectedDiskSymbol: 'SavedBaseline',
    },
  ])('does not revive a closed overlay from a captured rebuild candidate: $name', async ({
    diskText,
    expectedDiskSymbol,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'usn-close-during-rebuild-'));
    const folderUri = pathToFileURL(root).href;
    const sourcePath = join(root, 'Closing.hlsl');
    const uri = pathToFileURL(sourcePath).href;
    const liveText = 'float4 ClosedLive() { return 0; }';
    const candidateCaptured = deferred();
    const releaseCandidate = deferred();
    const delegate = new DefaultIndexedRevisionCandidateConstructor({
      folderUri,
      releaseVersion: null,
      indexDocument: indexFile,
    });
    const candidateConstructor: IndexedRevisionCandidateConstructor = {
      async construct(input) {
        if (!input.previous) return delegate.construct(input);
        const candidate = input.previous.fork(input.settings);
        candidateCaptured.resolve();
        await releaseCandidate.promise;
        return candidate;
      },
    };
    let rebuilding: Promise<void> | undefined;

    try {
      if (diskText !== undefined) await writeFile(sourcePath, diskText);
      const workspace = new Workspace(folderUri, DEFAULT_SETTINGS, { candidateConstructor });
      await workspace.initialize(connection);
      await workspace.updateDocument({
        uri,
        languageId: 'hlsl',
        text: liveText,
        openId: 1,
        version: 1,
      });
      expect(workspace.workspaceSymbols('ClosedLive')).toHaveLength(1);

      rebuilding = workspace.rebuild(connection);
      await candidateCaptured.promise;
      await workspace.closeDocument({ uri, openId: 1 });
      expect(workspace.workspaceSymbols('ClosedLive')).toHaveLength(0);

      releaseCandidate.resolve();
      await rebuilding;
      expect(workspace.workspaceSymbols('ClosedLive')).toHaveLength(0);
      if (expectedDiskSymbol) {
        expect(workspace.workspaceSymbols(expectedDiskSymbol)).toHaveLength(1);
      } else {
        expect(await workspace.documentSymbols({ uri })).toBeNull();
      }
    } finally {
      releaseCandidate.resolve();
      await Promise.allSettled([rebuilding ?? Promise.resolve()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never publishes a revision that drops another concurrent live overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-live-cas-rebuild-'));
    const folderUri = pathToFileURL(root).href;
    const firstUri = pathToFileURL(join(root, 'First.hlsl')).href;
    const secondUri = pathToFileURL(join(root, 'Second.hlsl')).href;
    const bothParsesStarted = deferred();
    const candidateCaptured = deferred();
    const releaseCandidate = deferred();
    let liveParseCount = 0;
    const delegate = new DefaultIndexedRevisionCandidateConstructor({
      folderUri,
      releaseVersion: null,
      async indexDocument(uri, text, recognizer, analysis) {
        if (text.includes('ConcurrentLive')) {
          liveParseCount++;
          if (liveParseCount === 2) bothParsesStarted.resolve();
          await bothParsesStarted.promise;
        }
        return indexFile(uri, text, recognizer, analysis);
      },
    });
    const candidateConstructor: IndexedRevisionCandidateConstructor = {
      async construct(input) {
        if (!input.previous) return delegate.construct(input);
        const candidate = input.previous.fork(input.settings);
        candidateCaptured.resolve();
        await releaseCandidate.promise;
        return candidate;
      },
    };
    const publicationStates: Array<{ first: boolean; second: boolean }> = [];
    let workspace!: Workspace;
    let rebuilding: Promise<void> | undefined;

    try {
      workspace = new Workspace(folderUri, DEFAULT_SETTINGS, {
        candidateConstructor,
        onIndexStatusChanged() {
          if (!workspace.canServe()) return;
          publicationStates.push({
            first: workspace.workspaceSymbols('FirstConcurrentLive').length > 0,
            second: workspace.workspaceSymbols('SecondConcurrentLive').length > 0,
          });
        },
      });
      await workspace.initialize(connection);
      rebuilding = workspace.rebuild(connection);
      await candidateCaptured.promise;

      await Promise.all([
        workspace.updateDocument({
          uri: firstUri,
          languageId: 'hlsl',
          text: 'float4 FirstConcurrentLive() { return 0; }',
          openId: 1,
          version: 1,
        }),
        workspace.updateDocument({
          uri: secondUri,
          languageId: 'hlsl',
          text: 'float4 SecondConcurrentLive() { return 0; }',
          openId: 2,
          version: 1,
        }),
      ]);

      expect(publicationStates.some((state) => state.first !== state.second)).toBe(true);
      expectPublishedFactsNeverDisappear(publicationStates);
      expect(workspace.workspaceSymbols('FirstConcurrentLive')).toHaveLength(1);
      expect(workspace.workspaceSymbols('SecondConcurrentLive')).toHaveLength(1);

      releaseCandidate.resolve();
      await rebuilding;
      expectPublishedFactsNeverDisappear(publicationStates);
      expect(workspace.workspaceSymbols('FirstConcurrentLive')).toHaveLength(1);
      expect(workspace.workspaceSymbols('SecondConcurrentLive')).toHaveLength(1);
    } finally {
      releaseCandidate.resolve();
      await Promise.allSettled([rebuilding ?? Promise.resolve()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function expectPublishedFactsNeverDisappear(
  states: readonly { first: boolean; second: boolean }[],
): void {
  let sawFirst = false;
  let sawSecond = false;
  for (const state of states) {
    if (sawFirst) expect(state.first).toBe(true);
    if (sawSecond) expect(state.second).toBe(true);
    sawFirst ||= state.first;
    sawSecond ||= state.second;
  }
}

async function settlesBefore<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('interactive query waited for the rebuild candidate')),
      milliseconds,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function positionOf(text: string, token: string, occurrence: number) {
  let offset = -token.length;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(token, offset + token.length);
  }
  if (offset < 0) throw new Error(`missing token ${token}`);
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}
