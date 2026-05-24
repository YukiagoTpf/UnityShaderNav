import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // __dirname at runtime = unity-shader-nav/tests/out
  const monorepoRoot = path.resolve(__dirname, '../..');
  const extensionDevelopmentPath = path.resolve(monorepoRoot, 'client');
  const extensionTestsPath = path.resolve(__dirname, './client/suite');

  const fixtureRel = process.env.USN_TEST_FIXTURE
    ?? 'tests/fixtures/01-scaffolding/empty-workspace';
  const workspaceFolder = path.resolve(monorepoRoot, fixtureRel);
  const profileRoot = await mkdtemp(path.join(os.tmpdir(), 'unity-shader-nav-vscode-profile-'));
  const workspaceFile = path.join(profileRoot, 'test.code-workspace');
  await writeFile(
    workspaceFile,
    JSON.stringify({ folders: [{ path: workspaceFolder }] }, null, 2),
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspaceFile,
        '--disable-extensions',
        `--user-data-dir=${path.join(profileRoot, 'user-data')}`,
        `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
      ],
    });
  } finally {
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
