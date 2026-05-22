import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // __dirname at runtime = unity-shader-nav/tests/out
  const monorepoRoot = path.resolve(__dirname, '../..');
  const extensionDevelopmentPath = path.resolve(monorepoRoot, 'client');
  const extensionTestsPath = path.resolve(__dirname, './client/suite');

  const fixtureRel = process.env.USN_TEST_FIXTURE
    ?? 'tests/fixtures/01-scaffolding/empty-workspace';
  const workspaceFolder = path.resolve(monorepoRoot, fixtureRel);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspaceFolder, '--disable-extensions'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
