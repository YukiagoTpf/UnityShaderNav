import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import runtimeArtifacts from './runtime-artifacts.cjs';
import vsixFileModes from './vsix-file-modes.cjs';

const require = createRequire(import.meta.url);
const yazl = require('yazl');
const yauzl = require('yauzl');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('VSIX mode normalization makes only the exact terminator entry executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-modes-'));
  const vsixPath = join(root, 'windows-source-mode.vsix');
  try {
    await writeWindowsModeFixture(vsixPath);
    const sourceModes = await readZipModes(vsixPath);
    assert.equal(sourceModes.get('extension/out/terminateProcess.sh'), 0o100666);
    assert.equal(sourceModes.get('extension/out/ordinary.js'), 0o100666);

    await vsixFileModes.normalizeVsixFileModes(vsixPath);

    const packagedModes = await readZipModes(vsixPath);
    assert.equal(packagedModes.get('extension/out/terminateProcess.sh'), 0o100755);
    assert.equal(packagedModes.get('extension/out/terminateProcess.sh.backup'), 0o100644);
    assert.equal(packagedModes.get('extension/out/ordinary.js'), 0o100644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VSIX mode normalization accepts ZIP64 input through library APIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-zip64-'));
  const vsixPath = join(root, 'zip64-source.vsix');
  try {
    await writeModeFixture(vsixPath, [
      'extension/out/terminateProcess.sh',
      'extension/out/ordinary.js',
    ], { forceZip64Format: true });

    await vsixFileModes.normalizeVsixFileModes(vsixPath);

    const packagedModes = await readZipModes(vsixPath);
    assert.equal(packagedModes.get('extension/out/terminateProcess.sh'), 0o100755);
    assert.equal(packagedModes.get('extension/out/ordinary.js'), 0o100644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package entry point normalizes a Windows-mode VSIX before accepting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-package-modes-'));
  try {
    await writePackageFixture(root);
    const fakeBin = await writeFakeNpx(root);
    const result = spawnSync(
      process.execPath,
      [resolve(repositoryRoot, 'scripts/package-vsix.mjs'), '--monorepo-root', root],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);

    const modes = await readZipModes(join(root, 'client/fixture-extension-1.2.3.vsix'));
    assert.equal(modes.get('extension/out/terminateProcess.sh'), 0o100755);
    assert.equal(modes.get('extension/out/ordinary.js'), 0o100644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('entry read failure preserves the original VSIX and removes temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-read-failure-'));
  const vsixPath = join(root, 'corrupt-entry.vsix');
  try {
    await writeCorruptEntryFixture(vsixPath);
    const original = await readFile(vsixPath);

    await assert.rejects(vsixFileModes.normalizeVsixFileModes(vsixPath));

    assert.deepEqual(await readFile(vsixPath), original);
    assert.deepEqual(await readdir(root), ['corrupt-entry.vsix']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing executable entry preserves the original VSIX and removes temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-missing-entry-'));
  const vsixPath = join(root, 'missing-entry.vsix');
  try {
    await writeModeFixture(vsixPath, ['extension/out/ordinary.js']);
    const original = await readFile(vsixPath);

    await assert.rejects(
      vsixFileModes.normalizeVsixFileModes(vsixPath),
      /must contain exactly one extension\/out\/terminateProcess\.sh entry; found 0/,
    );

    assert.deepEqual(await readFile(vsixPath), original);
    assert.deepEqual(await readdir(root), ['missing-entry.vsix']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate executable entries preserve the original VSIX and remove temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-duplicate-entry-'));
  const vsixPath = join(root, 'duplicate-entry.vsix');
  try {
    await writeModeFixture(vsixPath, [
      'extension/out/terminateProcess.sh',
      'extension/out/terminateProcess.sh',
    ]);
    const original = await readFile(vsixPath);

    await assert.rejects(
      vsixFileModes.normalizeVsixFileModes(vsixPath),
      /contains duplicate extension\/out\/terminateProcess\.sh entries/,
    );

    assert.deepEqual(await readFile(vsixPath), original);
    assert.deepEqual(await readdir(root), ['duplicate-entry.vsix']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('output stream failure preserves the original VSIX and removes temporary output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-write-failure-'));
  const vsixPath = join(root, 'write-failure.vsix');
  try {
    await writeWindowsModeFixture(vsixPath);
    const original = await readFile(vsixPath);

    await assert.rejects(
      vsixFileModes.normalizeVsixFileModes(vsixPath, {
        createOutputStream: () => new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('fixture output failure'));
          },
        }),
      }),
      /fixture output failure/,
    );

    assert.deepEqual(await readFile(vsixPath), original);
    assert.deepEqual(await readdir(root), ['write-failure.vsix']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized entry is rejected before the original VSIX is replaced', { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-vsix-oversized-entry-'));
  const vsixPath = join(root, 'oversized-entry.vsix');
  try {
    await writeOversizedEntryFixture(vsixPath);
    const original = await readFile(vsixPath);

    await assert.rejects(
      vsixFileModes.normalizeVsixFileModes(vsixPath),
      /extension\/out\/terminateProcess\.sh exceeds the 32 MiB entry limit/,
    );

    assert.deepEqual(await readFile(vsixPath), original);
    assert.deepEqual(await readdir(root), ['oversized-entry.vsix']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function writeWindowsModeFixture(vsixPath) {
  return writeModeFixture(vsixPath, [
    'extension/out/terminateProcess.sh',
    'extension/out/terminateProcess.sh.backup',
    'extension/out/ordinary.js',
  ]);
}

function writeModeFixture(vsixPath, names, options = {}) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const name of names) {
      zip.addBuffer(Buffer.from(`fixture: ${name}\n`), name, {
        mode: 0o100666,
        forceZip64Format: options.forceZip64Format,
      });
    }
    zip.end({ forceZip64Format: options.forceZip64Format });
    const output = createWriteStream(vsixPath);
    zip.outputStream.pipe(output);
    zip.outputStream.once('error', reject);
    output.once('error', reject);
    output.once('finish', resolve);
  });
}

function readZipModes(vsixPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const modes = new Map();
      zip.once('error', reject);
      zip.once('close', () => resolve(modes));
      zip.on('entry', (entry) => {
        modes.set(entry.fileName, entry.externalFileAttributes >>> 16);
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

async function writeCorruptEntryFixture(vsixPath) {
  const payload = Buffer.from(Array.from({ length: 4_096 }, (_, index) => (
    (index * 31 + (index >> 3)) & 0xff
  )));
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(payload, 'extension/out/terminateProcess.sh', { mode: 0o100666 });
    zip.end();
    const output = createWriteStream(vsixPath);
    zip.outputStream.pipe(output);
    zip.outputStream.once('error', reject);
    output.once('error', reject);
    output.once('finish', resolve);
  });

  const contents = await readFile(vsixPath);
  const compressed = deflateRawSync(payload);
  const compressedOffset = contents.indexOf(compressed);
  assert.notEqual(compressedOffset, -1, 'fixture must contain the expected deflate stream');
  assert.equal(
    contents.lastIndexOf(compressed),
    compressedOffset,
    'fixture deflate stream must be unique',
  );
  contents[compressedOffset] |= 0x06;
  await writeFile(vsixPath, contents);
}

function writeOversizedEntryFixture(vsixPath) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      Buffer.alloc(32 * 1024 * 1024 + 1),
      'extension/out/terminateProcess.sh',
      { mode: 0o100666 },
    );
    zip.end();
    const output = createWriteStream(vsixPath);
    zip.outputStream.pipe(output);
    zip.outputStream.once('error', reject);
    output.once('error', reject);
    output.once('finish', resolve);
  });
}

async function writePackageFixture(root) {
  const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
  for (const file of graph.packageFiles) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(file.minBytes, 'x'));
    if (file.executable && process.platform !== 'win32') await chmod(target, 0o755);
  }
  await writeFile(
    join(root, 'client/package.json'),
    `${JSON.stringify({
      name: 'fixture-extension',
      version: '1.2.3',
      publisher: 'fixture',
      engines: { vscode: '^1.85.0' },
      main: './out/extension.js',
      activationEvents: ['onLanguage:hlsl'],
    })}${' '.repeat(64)}`,
  );
  for (const name of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
    await writeFile(join(root, name), name.repeat(16));
  }
}

async function writeFakeNpx(root) {
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  const fakeNpxScript = join(fakeBin, 'fake-npx.cjs');
  await writeFile(fakeNpxScript, [
    "const { createWriteStream } = require('node:fs');",
    `const { ZipFile } = require(${JSON.stringify(require.resolve('yazl'))});`,
    'const args = process.argv.slice(2);',
    "const outIndex = args.indexOf('--out');",
    "if (outIndex < 0 || !args[outIndex + 1]) throw new Error('missing --out');",
    'const zip = new ZipFile();',
    "zip.addBuffer(Buffer.alloc(1024, 's'), 'extension/out/terminateProcess.sh', { mode: 0o100666, compress: false });",
    "zip.addBuffer(Buffer.alloc(1024, 'j'), 'extension/out/ordinary.js', { mode: 0o100666, compress: false });",
    'zip.end();',
    'zip.outputStream.pipe(createWriteStream(args[outIndex + 1]));',
  ].join('\n'));
  if (process.platform === 'win32') {
    await writeFile(
      join(fakeBin, 'npx.cmd'),
      `@"${process.execPath}" "%~dp0fake-npx.cjs" %*\r\n`,
    );
  } else {
    const fakeNpx = join(fakeBin, 'npx');
    await writeFile(fakeNpx, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeNpxScript)});\n`);
    await chmod(fakeNpx, 0o755);
  }
  return fakeBin;
}
