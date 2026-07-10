import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseGrammarProvenance,
  PROVENANCE_PATH,
} from './tree-sitter-hlsl-provenance.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..');

export async function rebuildGrammar() {
  const provenance = parseGrammarProvenance(
    await readFile(resolve(repositoryRoot, PROVENANCE_PATH), 'utf8'),
  );
  const tempRoot = await mkdtemp(join(tmpdir(), 'usn-grammar-rebuild-'));
  const sourceRoot = join(tempRoot, 'source');
  const builtArtifact = join(tempRoot, 'tree-sitter-hlsl.wasm');

  try {
    await run('git', ['init', '--quiet', sourceRoot], tempRoot);
    await run('git', ['-C', sourceRoot, 'remote', 'add', 'origin', provenance.source.repository]);
    await run('git', [
      '-C', sourceRoot,
      'fetch', '--quiet', '--depth', '1', 'origin', provenance.source.commit,
    ]);
    await run('git', ['-C', sourceRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);

    const sourceCommit = (await capture('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])).trim();
    assertEqual(sourceCommit, provenance.source.commit, 'source commit');

    const packageSpec = `tree-sitter-cli@${provenance.toolchain.treeSitterCli.version}`;
    const registryArg = `--registry=${provenance.toolchain.treeSitterCli.registry}`;
    const registryIntegrity = (await captureNpm(
      ['view', packageSpec, 'dist.integrity', registryArg],
    )).trim();
    assertEqual(
      registryIntegrity,
      provenance.toolchain.treeSitterCli.integrity,
      'tree-sitter-cli registry integrity',
    );

    const emscripten = provenance.toolchain.emscripten;
    const imageByDigest = `${emscripten.image}@${emscripten.digest}`;
    const imageByTag = `${emscripten.image}:${emscripten.tag}`;
    await run('docker', ['pull', '--platform', emscripten.platform, imageByDigest]);
    await run('docker', ['tag', imageByDigest, imageByTag]);

    await runNpm(
      [
        'exec', '--yes', registryArg, `--package=${packageSpec}`, '--',
        'tree-sitter', 'build', '--wasm', '--docker',
        '--output', builtArtifact,
        sourceRoot,
      ],
      sourceRoot,
      { DOCKER_DEFAULT_PLATFORM: emscripten.platform },
    );

    const builtBytes = await verifiedBytes(
      builtArtifact,
      provenance.artifact.size,
      provenance.artifact.sha256,
      'rebuilt grammar',
    );
    const sourceLicense = resolve(sourceRoot, 'LICENSE');
    const licenseBytes = await verifiedBytes(
      sourceLicense,
      undefined,
      provenance.source.licenseSha256,
      'upstream license',
    );

    const checkedArtifact = resolve(repositoryRoot, provenance.artifact.path);
    const checkedLicense = resolve(repositoryRoot, provenance.source.licensePath);
    assertBuffersEqual(builtBytes, await readFile(checkedArtifact), 'checked-in grammar');
    assertBuffersEqual(licenseBytes, await readFile(checkedLicense), 'checked-in upstream license');

    console.log('[grammar] rebuild is byte-identical to the checked-in grammar and license');
    console.log(`[grammar] ${provenance.artifact.size} bytes; sha256 ${provenance.artifact.sha256}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function npmInvocation(
  args,
  platform = process.platform,
  commandShell = process.env.ComSpec ?? process.env.COMSPEC,
) {
  if (platform !== 'win32') return { command: 'npm', args };
  return {
    command: commandShell || 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd', ...args],
  };
}

async function verifiedBytes(path, expectedSize, expectedHash, label) {
  const fileStat = await stat(path);
  if (expectedSize !== undefined) assertEqual(fileStat.size, expectedSize, `${label} size`);
  const bytes = await readFile(path);
  assertEqual(sha256(bytes), expectedHash, `${label} sha256`);
  return bytes;
}

function assertBuffersEqual(actual, expected, label) {
  if (!actual.equals(expected)) throw new Error(`${label} differs from the reproducible build`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function captureNpm(args, cwd = repositoryRoot) {
  const invocation = npmInvocation(args);
  return capture(invocation.command, invocation.args, cwd);
}

async function runNpm(args, cwd = repositoryRoot, extraEnv = {}) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, cwd, extraEnv);
}

async function capture(command, args, cwd = repositoryRoot) {
  let output = '';
  await run(command, args, cwd, {}, (chunk) => {
    output += chunk;
  });
  return output;
}

function run(command, args, cwd = repositoryRoot, extraEnv = {}, onStdout) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: onStdout ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      shell: false,
    });
    if (onStdout) child.stdout.on('data', (chunk) => onStdout(String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv.length !== 2) {
    throw new Error('Usage: node scripts/rebuild-tree-sitter-hlsl.mjs');
  }
  await rebuildGrammar();
}
