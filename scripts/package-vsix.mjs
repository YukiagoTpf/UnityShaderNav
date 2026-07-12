import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import runtimeArtifacts from './runtime-artifacts.cjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const monorepoRoot = resolve(args.monorepoRoot ?? defaultRoot);
const clientRoot = resolve(monorepoRoot, 'client');
const artifactGraph = runtimeArtifacts.createRuntimeArtifactGraph(monorepoRoot);
const requiredVsixEntries = artifactGraph.requiredVsixEntries;
const forbiddenVsixEntryPatterns = [
  /^extension\/.*\.tsbuildinfo$/,
];

try {
  if (args.verifyVsix) {
    await assertVsixContents(resolve(args.verifyVsix));
    process.exit(0);
  }

  if (args.buildAndVerify) {
    await removeVersionedVsix();
    await runNpmScript('clean');
    await runNpmScript('build');
  }

  const trustedManifest = await runtimeArtifacts.assertFreshRuntimeArtifacts(artifactGraph);
  if (args.prepareExtensionRoot) {
    await stageExtensionRootFiles();
    console.log('[package-vsix] staged README.md and LICENSE for VSCE packaging');
    process.exit(0);
  }
  if (args.checkOutput) process.exit(0);

  const vsixPath = await packageVsix();
  await assertVsixContents(vsixPath, trustedManifest);

  console.log(`[package-vsix] verified ${relative(monorepoRoot, vsixPath)}`);
  for (const entry of requiredVsixEntries) console.log(`[package-vsix] contains ${entry}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function assertVsixContents(vsixPath, trustedManifest) {
  const entries = await listZipEntries(vsixPath);
  for (const entry of requiredVsixEntries) {
    if (!entries.has(entry)) {
      throw new Error(`VSIX is missing required file ${entry}`);
    }
  }
  for (const entry of entries) {
    if (forbiddenVsixEntryPatterns.some((pattern) => pattern.test(entry))) {
      throw new Error(`VSIX must not include generated file ${entry}`);
    }
  }
  const embeddedManifest = runtimeArtifacts.parseRuntimeArtifactManifest(
    (await readZipEntry(vsixPath, 'extension/out/runtime-artifacts.json')).toString('utf8'),
  );
  if (trustedManifest) {
    runtimeArtifacts.assertRuntimeArtifactManifestsEqual(
      trustedManifest,
      embeddedManifest,
    );
  }
  const expectedManifest = trustedManifest ?? embeddedManifest;
  const expectedOutEntries = new Set([
    'extension/out/runtime-artifacts.json',
    ...Object.keys(expectedManifest.packagedArtifacts)
      .map(runtimeArtifacts.vsixEntryForOutput),
  ]);
  for (const entry of entries) {
    if (
      entry.startsWith('extension/out/')
      && !entry.endsWith('/')
      && !expectedOutEntries.has(entry)
    ) throw new Error(`VSIX contains runtime file outside the artifact graph: ${entry}`);
  }
  for (const [output, expectedHash] of Object.entries(expectedManifest.packagedArtifacts)) {
    const entry = runtimeArtifacts.vsixEntryForOutput(output);
    if (!entries.has(entry)) throw new Error(`VSIX is missing assembled runtime file ${entry}`);
    const actualHash = runtimeArtifacts.sha256RuntimeArtifact(
      await readZipEntry(vsixPath, entry),
    );
    if (actualHash !== expectedHash) {
      throw new Error(`VSIX runtime bytes differ from the build manifest: ${entry}`);
    }
  }
}

async function packageVsix() {
  const vsixPath = await versionedVsixPath();
  await rm(vsixPath, { force: true });
  const restoreExtensionRootFiles = await stageExtensionRootFiles();

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
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx.cmd', ...npxArgs] : npxArgs;
  try {
    await run(command, commandArgs, clientRoot);
    return vsixPath;
  } finally {
    await restoreExtensionRootFiles();
  }
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
  const restoreReadme = await stageFile(repoFile('README.md'), resolve(clientRoot, 'README.md'));
  const restoreLicense = await stageFile(repoFile('LICENSE'), resolve(clientRoot, 'LICENSE'));

  return async () => {
    await restoreReadme();
    await restoreLicense();
  };
}

async function stageFile(source, target) {
  let previous;
  try {
    previous = await readFile(target);
  } catch {
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

async function listZipEntries(zipPath) {
  const buffer = await readFile(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const end = centralDirectoryOffset + centralDirectorySize;
  const entries = new Set();
  let offset = centralDirectoryOffset;

  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory in ${zipPath}`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    if (entries.has(name)) throw new Error(`VSIX contains duplicate entry ${name}`);
    entries.add(name);
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function readZipEntry(zipPath, targetName) {
  const buffer = await readFile(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const end = centralDirectoryOffset + centralDirectorySize;
  let offset = centralDirectoryOffset;

  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory in ${zipPath}`);
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    if (name === targetName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header for ${targetName}`);
      }
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const contents = compression === 0
        ? Buffer.from(compressed)
        : compression === 8
          ? inflateRawSync(compressed)
          : undefined;
      if (!contents) {
        throw new Error(`Unsupported ZIP compression ${compression} for ${targetName}`);
      }
      if (contents.byteLength !== uncompressedSize) {
        throw new Error(`Invalid ZIP entry size for ${targetName}`);
      }
      return contents;
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  throw new Error(`VSIX is missing required file ${targetName}`);
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Invalid VSIX: missing ZIP end of central directory');
}

function parseArgs(rawArgs) {
  const parsed = {
    buildAndVerify: false,
    checkOutput: false,
    monorepoRoot: undefined,
    prepareExtensionRoot: false,
    verifyVsix: undefined,
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
    } else if (arg === '--verify-vsix') {
      parsed.verifyVsix = rawArgs[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}
