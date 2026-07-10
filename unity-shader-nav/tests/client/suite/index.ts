import * as path from 'node:path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
  const testsRoot = path.resolve(__dirname, '../..');
  const suite = process.env.USN_TEST_SUITE;
  const pattern = suite === 'activation'
    ? 'client/activation.test.js'
    : suite === 'integration'
      ? 'integration/client/**/*.test.js'
      : undefined;
  if (!pattern) throw new Error(`Unknown USN_TEST_SUITE: ${JSON.stringify(suite)}`);

  const files = (await glob(pattern, { cwd: testsRoot })).sort();
  if (files.length === 0) throw new Error(`No Electron tests matched ${pattern}`);
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} failed`)) : resolve()));
  });
}
