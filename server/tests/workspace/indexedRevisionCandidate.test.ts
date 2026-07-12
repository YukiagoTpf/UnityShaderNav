import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '@unity-shader-nav/shared';
import { describe, expect, it } from 'vitest';
import { DefaultIndexedRevisionCandidateConstructor } from '../../src/workspace/indexedRevisionCandidate';

const connection = {
  console: { log() {}, warn() {} },
  window: {
    createWorkDoneProgress: async () => ({
      begin() {},
      report() {},
      done() {},
    }),
  },
} as never;

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DefaultIndexedRevisionCandidateConstructor', () => {
  it('returns a complete unpublished candidate for a cold Unity source scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cold-candidate-'));
    const folderUri = pathToFileURL(root).href;
    const sourcePath = join(root, 'Assets', 'Shaders', 'Cold.hlsl');
    const sourceUri = pathToFileURL(sourcePath).href;
    await mkdir(join(root, 'Assets', 'Shaders'), { recursive: true });
    await mkdir(join(root, 'Packages'), { recursive: true });
    await mkdir(join(root, 'ProjectSettings'), { recursive: true });
    await writeFile(join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}');
    await writeFile(sourcePath, 'float4 ColdCandidateSymbol() { return 0; }');

    try {
      const constructor = new DefaultIndexedRevisionCandidateConstructor({ folderUri });
      const candidate = await constructor.construct({
        connection,
        settings: DEFAULT_SETTINGS,
        signal: new AbortController().signal,
      });

      expect(candidate.configuration).toMatchObject({ folderUri, unityRoot: root });
      expect(candidate.file(sourceUri)?.symbols).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ColdCandidateSymbol' }),
      ]));
      expect(candidate.warningCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects construction when cancellation wins during parser readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usn-cancelled-candidate-'));
    const parserStarted = deferred();
    const releaseParser = deferred();
    const controller = new AbortController();
    const reason = new Error('candidate construction cancelled');

    try {
      const constructor = new DefaultIndexedRevisionCandidateConstructor({
        folderUri: pathToFileURL(root).href,
        ensureParserReady: async () => {
          parserStarted.resolve();
          await releaseParser.promise;
        },
      });
      const constructing = constructor.construct({
        connection,
        settings: DEFAULT_SETTINGS,
        signal: controller.signal,
      });

      await parserStarted.promise;
      controller.abort(reason);
      releaseParser.resolve();

      await expect(constructing).rejects.toBe(reason);
    } finally {
      releaseParser.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });
});
