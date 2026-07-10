import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseElectronSuite,
  readPinnedVsCodeVersion,
  runElectronHarness,
} from './electronHarness';

interface FakeRepository {
  root: string;
  sandboxBase: string;
  cleanup(): Promise<void>;
}

suite('Electron harness', () => {
  test('accepts only explicit suite selectors and an exact pinned version', async () => {
    const fake = await createFakeRepository();
    try {
      assert.strictEqual(parseElectronSuite(['--suite', 'activation']), 'activation');
      assert.strictEqual(parseElectronSuite(['--suite=integration']), 'integration');
      assert.throws(() => parseElectronSuite([]), /Expected --suite/);
      assert.throws(() => parseElectronSuite(['--suite', 'all']), /Expected --suite/);
      assert.strictEqual(await readPinnedVsCodeVersion(fake.root), '1.85.2');

      await write(fake.root, 'tests/vscode-version.txt', 'stable\n');
      await assert.rejects(
        readPinnedVsCodeVersion(fake.root),
        /must contain an exact x\.y\.z version/,
      );
    } finally {
      await fake.cleanup();
    }
  });

  test('stages deterministic short paths without Library state and cleans successful runs', async () => {
    const fake = await createFakeRepository();
    const sourceBefore = await snapshotTree(fake.root);
    const captures: string[] = [];
    const sandboxRoots: string[] = [];
    try {
      for (let run = 0; run < 2; run++) {
        await runElectronHarness(
          {
            repositoryRoot: fake.root,
            fixtureRelativePath: 'tests/fixtures/empty-workspace',
            suite: 'integration',
            sandboxBase: fake.sandboxBase,
          },
          async (options) => {
            const sandboxRoot = options.extensionTestsEnv?.USN_HARNESS_ROOT;
            assert.ok(sandboxRoot);
            sandboxRoots.push(sandboxRoot);

            assert.strictEqual(options.version, '1.85.2');
            assert.strictEqual(options.cachePath, path.join(fake.root, '.vscode-test'));
            assert.strictEqual(options.reuseMachineInstall, false);
            assert.strictEqual(typeof options.extensionDevelopmentPath, 'string');
            assert.ok(isWithin(sandboxRoot, options.extensionDevelopmentPath as string));
            assert.ok(isWithin(sandboxRoot, options.extensionTestsPath));

            const launchArgs = options.launchArgs ?? [];
            const workspaceFile = launchArgs[0];
            const userDataArg = launchArgs.find((arg) => arg.startsWith('--user-data-dir='));
            const extensionsArg = launchArgs.find((arg) => arg.startsWith('--extensions-dir='));
            assert.ok(workspaceFile && isWithin(sandboxRoot, workspaceFile));
            assert.ok(userDataArg);
            assert.ok(extensionsArg);
            const userDataDir = userDataArg.slice('--user-data-dir='.length);
            assert.ok(isWithin(sandboxRoot, userDataDir));
            assert.ok(isWithin(sandboxRoot, extensionsArg.slice('--extensions-dir='.length)));
            assert.ok(
              Buffer.byteLength(path.join(userDataDir, '1.85-main.sock')) < 104,
              'short user-data path must leave room for a Darwin IPC socket',
            );

            const stagedTemp = options.extensionTestsEnv?.TMPDIR;
            assert.ok(stagedTemp && isWithin(sandboxRoot, stagedTemp));
            assert.strictEqual(options.extensionTestsEnv?.TMP, stagedTemp);
            assert.strictEqual(options.extensionTestsEnv?.TEMP, stagedTemp);
            assert.strictEqual(options.extensionTestsEnv?.USN_TEST_SUITE, 'integration');

            await assertPathExists(path.join(sandboxRoot, 'e', 'out', 'extension.js'));
            await assertPathExists(path.join(sandboxRoot, 't', 'tests', 'out', 'client', 'suite', 'index.js'));
            await assertPathExists(path.join(sandboxRoot, 't', 'node_modules'));
            await assertPathExists(path.join(sandboxRoot, 'w', '.gitkeep'));

            await assertPathMissing(path.join(sandboxRoot, 'w', 'Library'));
            await assertPathMissing(
              path.join(sandboxRoot, 't', 'tests', 'integration', 'client', 'fixtures', 'refs-project', 'Library'),
            );
            await assertPathMissing(
              path.join(sandboxRoot, 't', 'server', 'tests', 'include', 'fixtures', 'projectA', 'Library'),
            );
            await assertPathMissing(
              path.join(sandboxRoot, 't', 'server', 'tests', 'workspace', 'fixtures', 'projectB', 'Library'),
            );

            const workspace = JSON.parse(await fs.readFile(workspaceFile, 'utf8')) as {
              folders: Array<{ path: string }>;
            };
            assert.deepStrictEqual(workspace.folders, [{ path: path.join(sandboxRoot, 'w') }]);

            const normalizedOptions = normalizeSandbox(JSON.stringify(options), sandboxRoot);
            const normalizedTree = (await snapshotTree(sandboxRoot))
              .map((entry) => entry.startsWith('file:ws.code-workspace:')
                ? 'file:ws.code-workspace:<validated-workspace>'
                : normalizeSandbox(entry, sandboxRoot));
            captures.push(JSON.stringify({ normalizedOptions, normalizedTree }));
          },
        );
      }

      assert.strictEqual(captures.length, 2);
      assert.strictEqual(captures[0], captures[1]);
      assert.deepStrictEqual(await snapshotTree(fake.root), sourceBefore);
      for (const sandboxRoot of sandboxRoots) await assertPathMissing(sandboxRoot);
      assert.deepStrictEqual(await fs.readdir(fake.sandboxBase), []);
      await assertPathExists(
        path.join(fake.root, 'tests', 'integration', 'client', 'fixtures', 'refs-project', 'Library', 'cache.json'),
      );
    } finally {
      await fake.cleanup();
    }
  });

  test('cleans the sandbox and preserves the runner error', async () => {
    const fake = await createFakeRepository();
    let sandboxRoot: string | undefined;
    try {
      await assert.rejects(
        runElectronHarness(
          {
            repositoryRoot: fake.root,
            fixtureRelativePath: 'tests/fixtures/empty-workspace',
            suite: 'activation',
            sandboxBase: fake.sandboxBase,
          },
          async (options) => {
            sandboxRoot = options.extensionTestsEnv?.USN_HARNESS_ROOT;
            throw new Error('injected runner failure');
          },
        ),
        /injected runner failure/,
      );
      assert.ok(sandboxRoot);
      await assertPathMissing(sandboxRoot);
      assert.deepStrictEqual(await fs.readdir(fake.sandboxBase), []);
    } finally {
      await fake.cleanup();
    }
  });

  test('cleans a partially staged sandbox before the runner starts', async () => {
    const fake = await createFakeRepository();
    let runnerCalled = false;
    try {
      await fs.rm(path.join(fake.root, 'client', 'out'), { recursive: true, force: true });
      await assert.rejects(
        runElectronHarness(
          {
            repositoryRoot: fake.root,
            fixtureRelativePath: 'tests/fixtures/empty-workspace',
            suite: 'integration',
            sandboxBase: fake.sandboxBase,
          },
          async () => {
            runnerCalled = true;
          },
        ),
      );
      assert.strictEqual(runnerCalled, false);
      assert.deepStrictEqual(await fs.readdir(fake.sandboxBase), []);
    } finally {
      await fake.cleanup();
    }
  });
});

async function createFakeRepository(): Promise<FakeRepository> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usn-harness-fixture-'));
  const shortBase = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const sandboxBase = await fs.mkdtemp(path.join(shortBase, 'usn-harness-base-'));
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });

  const files: Array<[string, string]> = [
    ['client/package.json', '{"name":"fixture-extension","main":"./out/extension.js"}\n'],
    ['client/out/extension.js', 'module.exports = {};\n'],
    ['client/images/icon.png', 'fixture icon'],
    ['client/language-configuration/hlsl.json', '{}\n'],
    ['tests/out/client/suite/index.js', 'exports.run = async () => {};\n'],
    ['tests/out/integration/client/example.test.js', 'module.exports = {};\n'],
    ['tests/fixtures/empty-workspace/.gitkeep', ''],
    ['tests/fixtures/empty-workspace/Library/cache.json', 'stale workspace cache'],
    ['tests/integration/client/fixtures/refs-project/Assets/Test.hlsl', 'float4 Test;\n'],
    ['tests/integration/client/fixtures/refs-project/Library/cache.json', 'stale integration cache'],
    ['server/tests/include/fixtures/projectA/Assets/Test.hlsl', 'float4 TestA;\n'],
    ['server/tests/include/fixtures/projectA/Library/cache.json', 'stale include cache'],
    ['server/tests/workspace/fixtures/projectB/Assets/Test.hlsl', 'float4 TestB;\n'],
    ['server/tests/workspace/fixtures/projectB/Library/cache.json', 'stale workspace cache'],
    ['tests/vscode-version.txt', '1.85.2\n'],
  ];
  for (const [relativePath, content] of files) await write(root, relativePath, content);

  return {
    root,
    sandboxBase,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await fs.rm(sandboxBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function snapshotTree(root: string): Promise<string[]> {
  const entries: string[] = [];

  async function visit(current: string): Promise<void> {
    const names = (await fs.readdir(current)).sort();
    for (const name of names) {
      const absolutePath = path.join(current, name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        entries.push(`link:${relativePath}:${await fs.readlink(absolutePath)}`);
      } else if (stats.isDirectory()) {
        entries.push(`dir:${relativePath}`);
        await visit(absolutePath);
      } else {
        entries.push(`file:${relativePath}:${(await fs.readFile(absolutePath)).toString('base64')}`);
      }
    }
  }

  await visit(root);
  return entries;
}

function normalizeSandbox(value: string, sandboxRoot: string): string {
  return value.split(sandboxRoot).join('<sandbox>');
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function assertPathExists(target: string): Promise<void> {
  await fs.lstat(target);
}

async function assertPathMissing(target: string): Promise<void> {
  await assert.rejects(fs.lstat(target));
}
