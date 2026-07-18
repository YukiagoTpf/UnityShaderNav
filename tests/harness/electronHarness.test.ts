import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseElectronSuite,
  readPinnedVsCodeVersion,
  runElectronHarness,
} from './electronHarness';
import { waitForEventuallyWithObserver } from '../integration/client/helpers/eventually';

interface FakeRepository {
  root: string;
  sandboxBase: string;
  cleanup(): Promise<void>;
}

suite('Electron harness', () => {
  test('preserves the last predicate error when the deadline expires before a new query starts', async () => {
    let now = 0;
    let statusRequests = 0;
    let queryAttempts = 0;
    const status = { statusSequence: 1, workspaces: [] };

    await assert.rejects(
      waitForEventuallyWithObserver(
        {
          now: () => now,
          delay: async (ms) => {
            now += ms;
          },
          getStatus: async () => {
            statusRequests++;
            if (statusRequests === 2) now = 10;
            return status;
          },
        },
        'a deterministic deadline boundary',
        async () => {
          queryAttempts++;
          return { probe: 'latest-result' };
        },
        () => {
          throw new Error('latest predicate failure');
        },
        { timeoutMs: 10, retryMs: 5 },
      ),
      (error: Error) => {
        assert.match(error.message, /Last query result:[\s\S]*"probe": "latest-result"/);
        assert.match(error.message, /Last query error: Error: latest predicate failure/);
        return true;
      },
    );
    assert.strictEqual(queryAttempts, 1);
  });

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

  test('stages only the 15 graph-owned extension runtime files', async () => {
    const fake = await createFakeRepository();
    try {
      await runElectronHarness(
        {
          repositoryRoot: fake.root,
          fixtureRelativePath: 'tests/fixtures/empty-workspace',
          suite: 'activation',
          sandboxBase: fake.sandboxBase,
        },
        async (options) => {
          const sandboxRoot = options.extensionTestsEnv?.USN_HARNESS_ROOT;
          assert.ok(sandboxRoot);
          const extensionRoot = path.join(sandboxRoot, 'e');
          const stagedFiles = (await snapshotTree(extensionRoot))
            .filter((entry) => entry.startsWith('file:'))
            .map((entry) => entry.slice('file:'.length, entry.indexOf(':', 'file:'.length)))
            .sort();

          assert.deepStrictEqual(stagedFiles, [
            'images/icon.png',
            'language-configuration/hlsl.json',
            'language-configuration/shader.json',
            'out/THIRD_PARTY_NOTICES.txt',
            'out/extension.js',
            'out/grammars/tree-sitter-hlsl.LICENSE',
            'out/grammars/tree-sitter-hlsl.provenance.json',
            'out/grammars/tree-sitter-hlsl.wasm',
            'out/server/node_modules/web-tree-sitter/LICENSE',
            'out/server/node_modules/web-tree-sitter/package.json',
            'out/server/node_modules/web-tree-sitter/tree-sitter.js',
            'out/server/node_modules/web-tree-sitter/tree-sitter.wasm',
            'out/server/server.js',
            'out/terminateProcess.sh',
            'package.json',
          ]);
          if (process.platform !== 'win32') {
            const terminatorMode = (await fs.stat(
              path.join(extensionRoot, 'out/terminateProcess.sh'),
            )).mode;
            assert.notStrictEqual(terminatorMode & 0o111, 0);
          }
        },
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
            await assertPathExists(path.join(
              sandboxRoot,
              'e',
              'out',
              'grammars',
              'tree-sitter-hlsl.wasm',
            ));
            await assertPathExists(path.join(
              sandboxRoot,
              'e',
              'out',
              'server',
              'node_modules',
              'web-tree-sitter',
              'tree-sitter.wasm',
            ));
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
    ['client/out/client.js', 'loose client module\n'],
    ['client/out/THIRD_PARTY_NOTICES.txt', 'third-party notices\n'],
    ['client/out/extension.js', 'module.exports = {};\n'],
    ['client/out/grammars/tree-sitter-hlsl.LICENSE', 'grammar license'],
    ['client/out/grammars/tree-sitter-hlsl.provenance.json', '{"source":"fixture"}\n'],
    ['client/out/grammars/tree-sitter-hlsl.wasm', 'grammar'],
    ['client/out/server/parser/hlsl/parser.js', 'loose server module\n'],
    ['client/out/server/server.js', 'bundled server\n'],
    ['client/out/server/node_modules/web-tree-sitter/LICENSE', 'runtime license'],
    ['client/out/server/node_modules/web-tree-sitter/package.json', '{"name":"web-tree-sitter"}\n'],
    ['client/out/server/node_modules/web-tree-sitter/README.md', 'runtime readme'],
    ['client/out/server/node_modules/web-tree-sitter/tree-sitter.js', 'runtime'],
    ['client/out/server/node_modules/web-tree-sitter/tree-sitter-web.d.ts', 'runtime types'],
    ['client/out/server/node_modules/web-tree-sitter/tree-sitter.wasm', 'runtime wasm'],
    ['client/out/terminateProcess.sh', '#!/bin/sh\nexit 0\n'],
    ['client/images/icon.png', 'fixture icon'],
    ['client/language-configuration/hlsl.json', '{}\n'],
    ['client/language-configuration/shader.json', '{}\n'],
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
  if (process.platform !== 'win32') {
    await fs.chmod(path.join(root, 'client/out/terminateProcess.sh'), 0o755);
  }

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
