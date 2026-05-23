import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const monorepoRoot = resolve(args.monorepoRoot ?? defaultRoot);
const clientRoot = resolve(monorepoRoot, 'client');

const freshnessChecks = [
  {
    output: 'client/out/extension.js',
    inputs: [
      'client/src',
      'client/package.json',
      'shared/src',
      'tsconfig.base.json',
      'client/tsconfig.json',
      'scripts/build.mjs',
    ],
  },
  {
    output: 'client/out/server/server.js',
    inputs: [
      'server/src',
      'server/package.json',
      'shared/src',
      'shared/package.json',
      'tsconfig.base.json',
      'server/tsconfig.json',
      'scripts/build.mjs',
      'scripts/copy-server.mjs',
    ],
  },
  {
    output: 'client/out/grammars/tree-sitter-hlsl.wasm',
    inputs: ['server/grammars/tree-sitter-hlsl.wasm'],
  },
  {
    output: 'client/out/server/node_modules/web-tree-sitter/tree-sitter.js',
    inputs: ['node_modules/web-tree-sitter/tree-sitter.js'],
  },
  {
    output: 'client/out/server/node_modules/web-tree-sitter/tree-sitter.wasm',
    inputs: ['node_modules/web-tree-sitter/tree-sitter.wasm'],
  },
];

const requiredVsixEntries = [
  'extension/out/extension.js',
  'extension/out/server/server.js',
  'extension/out/grammars/tree-sitter-hlsl.wasm',
  'extension/out/server/node_modules/web-tree-sitter/tree-sitter.js',
  'extension/out/server/node_modules/web-tree-sitter/tree-sitter.wasm',
];
const forbiddenVsixEntryPatterns = [
  /^extension\/.*\.tsbuildinfo$/,
];

try {
  if (args.verifyVsix) {
    await assertVsixContents(resolve(args.verifyVsix));
    process.exit(0);
  }

  await assertFreshBuildOutputs(monorepoRoot);
  if (args.checkOutput) process.exit(0);

  const vsixPath = await packageVsix();
  await assertVsixContents(vsixPath);

  console.log(`[package-vsix] verified ${relative(monorepoRoot, vsixPath)}`);
  for (const entry of requiredVsixEntries) console.log(`[package-vsix] contains ${entry}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function assertFreshBuildOutputs(root) {
  for (const check of freshnessChecks) {
    const outputPath = resolve(root, check.output);
    const outputStat = await statOrThrow(outputPath, `${check.output} is missing; run npm run build before packaging`);
    const newest = await newestInput(root, check.inputs);
    if (outputStat.mtimeMs < newest.mtimeMs) {
      throw new Error(`${check.output} is stale; newest input ${newest.relativePath} is newer`);
    }
  }
}

async function assertVsixContents(vsixPath) {
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
}

async function newestInput(root, inputRels) {
  let newest = { mtimeMs: 0, relativePath: '' };
  for (const inputRel of inputRels) {
    const inputPath = resolve(root, inputRel);
    if (!existsSync(inputPath)) continue;
    for (const file of await listFiles(inputPath)) {
      const fileStat = await stat(file);
      if (fileStat.mtimeMs > newest.mtimeMs) {
        newest = { mtimeMs: fileStat.mtimeMs, relativePath: toPosix(relative(root, file)) };
      }
    }
  }
  if (!newest.relativePath) {
    throw new Error(`No freshness inputs found for ${inputRels.join(', ')}`);
  }
  return newest;
}

async function listFiles(pathToInspect) {
  const pathStat = await stat(pathToInspect);
  if (pathStat.isFile()) return [pathToInspect];
  if (!pathStat.isDirectory()) return [];

  const files = [];
  const entries = await readdir(pathToInspect, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = resolve(pathToInspect, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function statOrThrow(file, message) {
  try {
    return await stat(file);
  } catch {
    throw new Error(message);
  }
}

async function packageVsix() {
  const packageJson = JSON.parse(await readFile(resolve(clientRoot, 'package.json'), 'utf8'));
  const vsixPath = resolve(clientRoot, `${packageJson.name}-${packageJson.version}.vsix`);
  await rm(vsixPath, { force: true });

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
  await run(command, commandArgs, clientRoot);
  return vsixPath;
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
    entries.add(name);
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Invalid VSIX: missing ZIP end of central directory');
}

function parseArgs(rawArgs) {
  const parsed = { checkOutput: false, monorepoRoot: undefined, verifyVsix: undefined };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--check-output') {
      parsed.checkOutput = true;
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

function toPosix(value) {
  return value.split(sep).join('/');
}
