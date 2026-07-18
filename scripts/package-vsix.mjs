import { existsSync } from 'node:fs';
import { copyFile, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listFiles, PackageManager } from '@vscode/vsce';
import runtimeArtifacts from './runtime-artifacts.cjs';

const MINIMUM_VSIX_BYTES = 1_024;
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const monorepoRoot = resolve(args.monorepoRoot ?? defaultRoot);
const clientRoot = resolve(monorepoRoot, 'client');
const artifactGraph = runtimeArtifacts.createRuntimeArtifactGraph(monorepoRoot);

try {
  if (args.buildAndVerify) {
    await removeVersionedVsix();
    await runNpmScript('clean');
    await runNpmScript('build');
  }

  await runtimeArtifacts.assertRuntimeArtifacts(artifactGraph);
  if (args.prepareExtensionRoot) {
    await prepareExtensionRoot();
    console.log('[package-vsix] staged README.md, CHANGELOG.md, and LICENSE for VSCE packaging');
    process.exit(0);
  }
  if (args.checkOutput) process.exit(0);

  const { vsixPath, vsixStat } = await packageVsix();

  console.log(
    `[package-vsix] verified ${relative(monorepoRoot, vsixPath)} (${vsixStat.size} bytes)`,
  );
  for (const packagePath of artifactGraph.requiredPackagePaths) {
    console.log(`[package-vsix] package plan contains ${packagePath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function packageVsix() {
  const vsixPath = await versionedVsixPath();
  await rm(vsixPath, { force: true });
  const restoreExtensionRootFiles = await stageExtensionRootFiles();
  let failure;
  let vsixStat;

  try {
    await assertPackageReady();
    const npxArgs = [
      '--no-install',
      'vsce',
      'package',
      '--no-dependencies',
      '--no-yarn',
      '--out',
      vsixPath,
    ];
    const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npx';
    const commandArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npx.cmd', ...npxArgs]
      : npxArgs;
    await run(command, commandArgs, clientRoot);
    await assertPackageReady();
    vsixStat = await assertVsixFile(vsixPath);
  } catch (error) {
    failure = asError(error);
  }

  try {
    await restoreExtensionRootFiles();
  } catch (error) {
    failure = mergeFailures(
      failure,
      asError(error),
      'VSIX packaging and extension-root restoration failed',
    );
  }

  if (failure) {
    try {
      await rm(vsixPath, { force: true });
    } catch (error) {
      failure = mergeFailures(
        failure,
        asError(error),
        `VSIX packaging failed and ${relative(monorepoRoot, vsixPath)} could not be removed`,
      );
    }
    throw failure;
  }

  return { vsixPath, vsixStat };
}

async function prepareExtensionRoot() {
  const restoreExtensionRootFiles = await stageExtensionRootFiles();
  try {
    await assertPackageReady();
  } catch (error) {
    let failure = asError(error);
    try {
      await restoreExtensionRootFiles();
    } catch (restoreError) {
      failure = mergeFailures(
        failure,
        asError(restoreError),
        'VSCE prepublish verification and extension-root restoration failed',
      );
    }
    throw failure;
  }
}

async function assertPackageReady() {
  await runtimeArtifacts.assertPackageFiles(artifactGraph);
  await assertPackagePlan();
}

async function assertPackagePlan() {
  const plannedFiles = await listFiles({
    cwd: clientRoot,
    packageManager: PackageManager.None,
  });
  await runtimeArtifacts.assertPackagePlan(artifactGraph, plannedFiles);
}

async function assertVsixFile(vsixPath) {
  let fileStat;
  try {
    fileStat = await lstat(vsixPath);
  } catch {
    throw new Error(`VSIX was not created: ${vsixPath}`);
  }
  if (!fileStat.isFile()) throw new Error(`VSIX output must be a regular file: ${vsixPath}`);
  if (fileStat.size < MINIMUM_VSIX_BYTES) {
    throw new Error(
      `VSIX output is truncated: ${fileStat.size} bytes; expected at least ${MINIMUM_VSIX_BYTES}`,
    );
  }
  return fileStat;
}

async function versionedVsixPath() {
  const packageJson = JSON.parse(await readFile(resolve(clientRoot, 'package.json'), 'utf8'));
  return resolve(clientRoot, `${packageJson.name}-${packageJson.version}.vsix`);
}

async function removeVersionedVsix() {
  const vsixPath = await versionedVsixPath();
  await rm(vsixPath, { force: true });
  console.log(`[package-vsix] removed pre-existing ${relative(monorepoRoot, vsixPath)}`);
}

async function runNpmScript(script) {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm';
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd', 'run', script]
    : ['run', script];
  await run(command, commandArgs, monorepoRoot);
}

async function stageExtensionRootFiles() {
  const restorers = [];
  try {
    for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
      restorers.unshift(await stageFile(repoFile(name), resolve(clientRoot, name)));
    }
  } catch (error) {
    let failure = asError(error);
    try {
      await restoreAll(restorers);
    } catch (restoreError) {
      failure = mergeFailures(
        failure,
        asError(restoreError),
        'Extension-root staging and restoration failed',
      );
    }
    throw failure;
  }
  return () => restoreAll(restorers);
}

async function restoreAll(restorers) {
  let failure;
  for (const restore of restorers) {
    try {
      await restore();
    } catch (error) {
      failure = mergeFailures(
        failure,
        asError(error),
        'Multiple extension-root files could not be restored',
      );
    }
  }
  if (failure) throw failure;
}

async function stageFile(source, target) {
  let previous;
  try {
    previous = await readFile(target);
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
    previous = undefined;
  }

  await copyFile(source, target);

  return async () => {
    if (previous) {
      await writeFile(target, previous);
    } else {
      await rm(target, { force: true });
    }
  };
}

function repoFile(name) {
  const source = resolve(monorepoRoot, name);
  if (!existsSync(source)) {
    throw new Error(`${name} is missing from the repository root`);
  }
  return source;
}

function run(command, commandArgs, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${code}`));
    });
  });
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function mergeFailures(primary, secondary, message) {
  if (!primary) return secondary;
  const errors = primary instanceof AggregateError
    ? [...primary.errors, secondary]
    : [primary, secondary];
  return new AggregateError(
    errors,
    `${message}: ${errors.map((error) => asError(error).message).join('; ')}`,
  );
}

function parseArgs(rawArgs) {
  const parsed = {
    buildAndVerify: false,
    checkOutput: false,
    monorepoRoot: undefined,
    prepareExtensionRoot: false,
  };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--build-and-verify') {
      parsed.buildAndVerify = true;
    } else if (arg === '--check-output') {
      parsed.checkOutput = true;
    } else if (arg === '--prepare-extension-root') {
      parsed.prepareExtensionRoot = true;
    } else if (arg === '--monorepo-root') {
      parsed.monorepoRoot = rawArgs[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
