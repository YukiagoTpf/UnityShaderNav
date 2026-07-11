import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addWorkspaceFolder,
  getIndexStatus,
  indexStatusForFolder,
  removeWorkspaceFolder,
  waitForEventually,
} from './helpers/workspace';

async function makeUnityProject(lockfile: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usn-index-status-'));
  await fs.mkdir(path.join(root, 'Assets', 'Shaders'), { recursive: true });
  await fs.mkdir(path.join(root, 'Packages'), { recursive: true });
  await fs.mkdir(path.join(root, 'ProjectSettings'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 2022.3.0f1\n',
  );
  await fs.writeFile(
    path.join(root, 'Assets', 'Shaders', 'Probe.hlsl'),
    'float4 StatusProbe() { return 1; }\n',
  );
  await fs.writeFile(path.join(root, 'Packages', 'packages-lock.json'), lockfile);
  return root;
}

async function removeIfPresent(root: string): Promise<void> {
  await removeWorkspaceFolder(root);
}

suite('Index status', () => {
  test('publishes ready state for an added root and removes the root from the snapshot', async () => {
    const root = await makeUnityProject('{"dependencies":{}}\n');
    try {
      const beforeAdd = await getIndexStatus();
      const handle = await addWorkspaceFolder(root);
      assert.equal(handle.added, true, 'temporary project should be added by this test');

      const readySnapshot = await getIndexStatus();
      assert.ok(
        readySnapshot.statusSequence > beforeAdd.statusSequence,
        'adding and indexing a root should advance the observable status sequence',
      );
      const ready = indexStatusForFolder(readySnapshot, root);
      assert.equal(ready?.mode, 'unity');
      assert.equal(ready?.lifecycle.state, 'ready');
      assert.ok(ready?.lifecycle.state === 'ready');
      assert.ok(ready.lifecycle.revision >= 1, 'ready workspace should expose a positive revision');

      await removeWorkspaceFolder(root);
      const removedSnapshot = await getIndexStatus();
      assert.ok(
        removedSnapshot.statusSequence > readySnapshot.statusSequence,
        'removing a root should advance the observable status sequence',
      );
      assert.equal(indexStatusForFolder(removedSnapshot, root), undefined);
    } finally {
      await removeIfPresent(root);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('surfaces malformed package state as an actionable failure and still removes the root', async () => {
    const root = await makeUnityProject('{ invalid json');
    try {
      const handle = await addWorkspaceFolder(root, { expectedState: 'failed' });
      assert.equal(handle.added, true, 'temporary failed project should be added by this test');

      const failedSnapshot = await getIndexStatus();
      const failed = indexStatusForFolder(failedSnapshot, root);
      assert.equal(failed?.mode, 'unity');
      assert.equal(failed?.lifecycle.state, 'failed');
      assert.ok(failed?.lifecycle.state === 'failed');
      assert.equal(failed.lifecycle.failure.category, 'package-resolution');
      assert.match(failed.lifecycle.failure.message, /Packages\/packages-lock\.json/i);

      await removeWorkspaceFolder(root);
      assert.equal(indexStatusForFolder(await getIndexStatus(), root), undefined);
    } finally {
      await removeIfPresent(root);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  test('eventual-condition timeouts include the last status, result, and error', async () => {
    await assert.rejects(
      waitForEventually(
        'an intentionally impossible integration condition',
        async () => ({ probe: 'latest-result' }),
        () => {
          throw new Error('latest predicate failure');
        },
        { timeoutMs: 500, retryMs: 25 },
      ),
      (error: Error) => {
        assert.match(error.message, /Last index status:/);
        assert.match(error.message, /Last query result:[\s\S]*"probe": "latest-result"/);
        assert.match(error.message, /Last query error: Error: latest predicate failure/);
        return true;
      },
    );

    const startedAt = Date.now();
    await assert.rejects(
      waitForEventually(
        'a query that never settles',
        async () => new Promise<never>(() => {}),
        () => false,
        { timeoutMs: 500, retryMs: 25 },
      ),
      (error: Error) => {
        assert.match(error.message, /Last index status:/);
        assert.match(error.message, /Last query result: <undefined>/);
        assert.match(error.message, /Query for a query that never settles did not settle/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 2000, 'helper timeout should be a hard deadline');
  });
});
