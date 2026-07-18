import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = (await readFile(
  join(repositoryRoot, '.github/workflows/ci.yml'),
  'utf8',
)).replaceAll('\r\n', '\n');
const rootPackage = JSON.parse(await readFile(
  join(repositoryRoot, 'package.json'),
  'utf8',
));

function step(name) {
  const lines = workflow.split('\n');
  const marker = `      - name: ${name}`;
  const start = lines.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = lines.findIndex((line, index) => (
    index > start && line.startsWith('      - name: ')
  ));
  return lines.slice(start, next === -1 ? undefined : next).join('\n');
}

test('fast verification runs in a non-cancelling Linux, Windows, and macOS matrix', () => {
  assert.match(workflow, /fail-fast: false/);
  assert.deepEqual(
    [...new Set(workflow.match(/(?:ubuntu|windows|macos)-latest/g) ?? [])].sort(),
    ['macos-latest', 'ubuntu-latest', 'windows-latest'],
  );
  assert.match(workflow, /runs-on: \$\{\{ matrix\.os \}\}/);

  const fastVerification = step('Run fast verification');
  assert.match(fastVerification, /run: npm run check:fast/);
  assert.doesNotMatch(fastVerification, /\n\s+if:/);

  const fastCommand = rootPackage.scripts?.['check:fast'] ?? '';
  assert.match(fastCommand, /npm run build/);
  assert.match(fastCommand, /npm run test -w @unity-shader-nav\/server/);

  const contractValidation = step('Validate CI workflow contract');
  assert.match(contractValidation, /node --test scripts\/ci-workflow\.test\.mjs/);
  assert.doesNotMatch(contractValidation, /\n\s+if:/);
});

test('Bash, package, and Electron work remains Linux-only', () => {
  for (const name of [
    'Read pinned VS Code test version',
    'Cache VS Code test runtime',
    'Run package verification',
    'Install Electron runtime libraries',
    'Run Electron verification',
  ]) {
    assert.match(step(name), /if: runner\.os == 'Linux'/, `${name} must be Linux-only`);
  }
  assert.match(step('Read pinned VS Code test version'), /shell: bash/);
});
