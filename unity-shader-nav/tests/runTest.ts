import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { parseElectronSuite, runElectronHarness } from './harness/electronHarness';

async function main(): Promise<void> {
  // __dirname at runtime = unity-shader-nav/tests/out
  const repositoryRoot = path.resolve(__dirname, '../..');
  const suite = parseElectronSuite(process.argv.slice(2));
  await runElectronHarness(
    {
      repositoryRoot,
      fixtureRelativePath: process.env.USN_TEST_FIXTURE
        ?? 'tests/fixtures/01-scaffolding/empty-workspace',
      suite,
    },
    runTests,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
