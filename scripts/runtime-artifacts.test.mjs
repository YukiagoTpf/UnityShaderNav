import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import runtimeArtifacts from './runtime-artifacts.cjs';

test('runtime graph owns the exact 18-file VSIX payload', () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const graph = runtimeArtifacts.createRuntimeArtifactGraph(repositoryRoot);
  const expectedPackagePaths = [
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'images/icon.png',
    'language-configuration/shader.json',
    'language-configuration/hlsl.json',
    'out/extension.js',
    'out/THIRD_PARTY_NOTICES.txt',
    'out/terminateProcess.sh',
    'out/server/server.js',
    'out/grammars/tree-sitter-hlsl.wasm',
    'out/grammars/tree-sitter-hlsl.provenance.json',
    'out/grammars/tree-sitter-hlsl.LICENSE',
    'out/server/node_modules/web-tree-sitter/LICENSE',
    'out/server/node_modules/web-tree-sitter/package.json',
    'out/server/node_modules/web-tree-sitter/tree-sitter.js',
    'out/server/node_modules/web-tree-sitter/tree-sitter.wasm',
  ];

  assert.deepEqual(
    [...graph.requiredPackagePaths].sort(),
    expectedPackagePaths.sort(),
  );
});

test('one graph assembles the complete grammar and web-tree-sitter runtime', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);

    assert.equal(
      await readFile(join(fixture.root, 'client/out/grammars/extra-grammar-fact.txt'), 'utf8'),
      'grammar-extra',
    );
    assert.equal(
      await readFile(join(
        fixture.root,
        'client/out/server/node_modules/web-tree-sitter/tree-sitter-web.d.ts',
      ), 'utf8'),
      'runtime-extra',
    );
    assert(fixture.graph.watchInputs.includes('node_modules/web-tree-sitter'));
    assert(fixture.graph.watchInputs.includes('package.json'));
    assert(fixture.graph.watchInputs.includes('package-lock.json'));
    assert.deepEqual(fixture.graph.bundles, [
      {
        id: 'extension',
        entry: 'client/src/extension.ts',
        output: 'client/out/extension.js',
      },
      {
        id: 'server',
        entry: 'server/src/server.ts',
        output: 'client/out/server/server.js',
      },
    ]);
    assert.deepEqual(
      fixture.graph.requiredOutputFiles,
      fixture.graph.runtimeFiles.map((file) => file.path),
    );
    assert(!fixture.graph.requiredOutputFiles.includes('client/out/runtime-artifacts.json'));
    for (const packagePath of [
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
      'language-configuration/shader.json',
      'language-configuration/hlsl.json',
      ...fixture.graph.runtimeFiles.map((file) => file.packagePath),
    ]) {
      assert(
        fixture.graph.requiredPackagePaths.includes(packagePath),
        `package graph must require ${packagePath}`,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test('runtime assembly installs an executable language-client terminator', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    const terminator = join(fixture.root, 'client/out/terminateProcess.sh');
    const contents = await readFile(terminator, 'utf8');

    assert.match(contents, /^#!\/bin\/sh/);
    if (process.platform !== 'win32') {
      assert.notEqual((await stat(terminator)).mode & 0o111, 0);
      const marker = join(fixture.root, 'terminator-marker.txt');
      const result = spawnSync(terminator, ['stuck-child'], {
        env: { ...process.env, USN_TERMINATOR_MARKER: marker },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.equal(await readFile(marker, 'utf8'), 'stuck-child');
    }
  } finally {
    await fixture.cleanup();
  }
});

test('runtime assertions reject a non-executable language-client terminator', {
  skip: process.platform === 'win32',
}, async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    await write(
      join(fixture.root, 'client/out/extension.js'),
      Buffer.alloc(2_048, 'e'),
    );
    await chmod(join(fixture.root, 'client/out/terminateProcess.sh'), 0o644);

    await assert.rejects(
      runtimeArtifacts.assertRuntimeArtifacts(fixture.graph),
      /client\/out\/terminateProcess\.sh must be executable/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('runtime artifact assertions reject a missing required output', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    await write(
      join(fixture.root, 'client/out/extension.js'),
      Buffer.alloc(2_048, 'e'),
    );
    await rm(join(
      fixture.root,
      'client/out/server/node_modules/web-tree-sitter/tree-sitter.js',
    ));

    await assert.rejects(
      runtimeArtifacts.assertRuntimeArtifacts(fixture.graph),
      /tree-sitter\.js is missing/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('runtime artifact assertions reject a truncated required output', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    await write(
      join(fixture.root, 'client/out/extension.js'),
      Buffer.alloc(2_048, 'e'),
    );
    await write(
      join(fixture.root, 'client/out/server/node_modules/web-tree-sitter/tree-sitter.js'),
      'truncated',
    );

    await assert.rejects(
      runtimeArtifacts.assertRuntimeArtifacts(fixture.graph),
      /tree-sitter\.js is truncated: 9 bytes; expected at least 1024/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('package assertions reject a truncated language configuration', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    await write(
      join(fixture.root, 'client/out/extension.js'),
      Buffer.alloc(2_048, 'e'),
    );
    await write(
      join(fixture.root, 'client/language-configuration/hlsl.json'),
      '{}',
    );

    await assert.rejects(
      runtimeArtifacts.assertPackageFiles(fixture.graph),
      /language-configuration\/hlsl\.json is truncated: 2 bytes; expected at least 32/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('runtime artifact assertions reject a parent symlink that escapes the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-runtime-root-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'usn-runtime-external-'));
  const linkedOutput = join(root, 'client/out');
  try {
    const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
    const extensionFile = graph.runtimeFiles.find((file) => (
      file.path === 'client/out/extension.js'
    ));
    assert(extensionFile);
    await mkdir(join(root, 'client'), { recursive: true });
    await write(join(externalRoot, 'extension.js'), Buffer.alloc(2_048, 'e'));
    await symlink(
      externalRoot,
      linkedOutput,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await assert.rejects(
      runtimeArtifacts.assertRuntimeArtifacts({
        ...graph,
        runtimeFiles: Object.freeze([extensionFile]),
      }),
      /client\/out\/extension\.js escapes the repository root/,
    );
  } finally {
    await unlink(linkedOutput).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('runtime artifact assertions reject a symlink in place of a critical file', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-runtime-symlink-'));
  try {
    const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
    const extensionFile = graph.runtimeFiles.find((file) => (
      file.path === 'client/out/extension.js'
    ));
    assert(extensionFile);
    const realBundle = join(root, 'client/out/real-extension.js');
    await write(realBundle, Buffer.alloc(2_048, 'e'));
    await symlink(realBundle, join(root, extensionFile.path), 'file');

    await assert.rejects(
      runtimeArtifacts.assertRuntimeArtifacts({
        ...graph,
        runtimeFiles: Object.freeze([extensionFile]),
      }),
      /client\/out\/extension\.js must be a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package plan rejects an extra symlink even when its target is a large file', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-package-plan-root-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'usn-package-plan-external-'));
  try {
    const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
    await mkdir(join(root, 'client'), { recursive: true });
    const externalFile = join(externalRoot, 'extra.bin');
    await write(externalFile, Buffer.alloc(2_048, 'e'));
    await symlink(externalFile, join(root, 'client/extra.bin'), 'file');

    await assert.rejects(
      runtimeArtifacts.assertPackagePlan(graph, ['extra.bin']),
      /VSCE package plan file extra\.bin must be a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('package plan rejects a file reached through an escaping parent symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-package-parent-root-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'usn-package-parent-external-'));
  const linkedParent = join(root, 'client/linked');
  try {
    const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
    await mkdir(join(root, 'client'), { recursive: true });
    await write(join(externalRoot, 'extra.bin'), Buffer.alloc(2_048, 'e'));
    await symlink(
      externalRoot,
      linkedParent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await assert.rejects(
      runtimeArtifacts.assertPackagePlan(graph, ['linked/extra.bin']),
      /VSCE package plan file linked\/extra\.bin escapes the extension root/,
    );
  } finally {
    await unlink(linkedParent).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});

test('package plan rejects duplicate and non-canonical raw paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usn-package-path-root-'));
  try {
    const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
    await write(join(root, 'client/package.json'), 'p'.repeat(64));

    await assert.rejects(
      runtimeArtifacts.assertPackagePlan(graph, ['package.json', 'package.json']),
      /VSCE package plan contains duplicate path package\.json/,
    );
    await assert.rejects(
      runtimeArtifacts.assertPackagePlan(graph, ['../outside']),
      /VSCE package plan path is not canonical: \.\.\/outside/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package plan rejects a regular file outside the exact graph allowlist', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    await write(
      join(fixture.root, 'client/out/extension.js'),
      Buffer.alloc(2_048, 'e'),
    );
    await write(join(fixture.root, 'client/extra.js'), 'module.exports = {};');

    await assert.rejects(
      runtimeArtifacts.assertPackagePlan(fixture.graph, [
        ...fixture.graph.requiredPackagePaths,
        'extra.js',
      ]),
      /VSCE package plan contains unexpected file extra\.js/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('runtime artifact contract has no content manifest or input freshness state', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    await write(
      join(fixture.root, 'client/out/extension.js'),
      Buffer.alloc(2_048, 'e'),
    );
    await write(join(fixture.root, 'server/src/server.ts'), 'changed input bytes');

    await runtimeArtifacts.assertRuntimeArtifacts(fixture.graph);
    assert.equal(fixture.graph.manifest, undefined);
    assert.equal(fixture.graph.manifestInputs, undefined);
    assert.equal(fixture.graph.freshnessChecks, undefined);
    assert.equal(runtimeArtifacts.writeRuntimeArtifactManifest, undefined);
    assert.equal(runtimeArtifacts.verifyRuntimeArtifactManifest, undefined);
    assert.equal(runtimeArtifacts.assertFreshRuntimeArtifacts, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('build, watch, packaging, tests, and Electron staging consume the graph', async () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const consumers = [
    'scripts/build.mjs',
    'scripts/copy-server.mjs',
    'scripts/package-vsix.mjs',
    'scripts/watch-runtime.mjs',
    'tests/client/package-layout.test.ts',
    'tests/harness/electronHarness.ts',
  ];
  for (const relativePath of consumers) {
    const source = await readFile(join(repositoryRoot, relativePath), 'utf8');
    assert.match(source, /runtime-artifacts\.cjs|ARTIFACT_GRAPH/);
  }

  for (const relativePath of [
    'scripts/build.mjs',
    'scripts/copy-server.mjs',
    'scripts/package-vsix.mjs',
    'scripts/watch-runtime.mjs',
  ]) {
    const source = await readFile(join(repositoryRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /server\/grammars|node_modules\/web-tree-sitter/);
  }
  const buildSource = await readFile(join(repositoryRoot, 'scripts/build.mjs'), 'utf8');
  for (const pathLiteral of [
    'client/src/extension.ts',
    'server/src/server.ts',
    'client/out/extension.js',
    'client/out/server/server.js',
  ]) {
    assert(!buildSource.includes(pathLiteral), `build caller must not own ${pathLiteral}`);
  }
  assert.match(buildSource, /assertRuntimeArtifacts/);
  assert.doesNotMatch(buildSource, /writeRuntimeArtifactManifest/);
  const packageSource = await readFile(
    join(repositoryRoot, 'scripts/package-vsix.mjs'),
    'utf8',
  );
  assert.match(packageSource, /listFiles/);
  assert.doesNotMatch(
    packageSource,
    /inflateRawSync|readUInt(?:16|32)LE|central directory|sha256/i,
  );
  const modeNormalizerSource = await readFile(
    join(repositoryRoot, 'scripts/vsix-file-modes.cjs'),
    'utf8',
  );
  assert.match(modeNormalizerSource, /require\(['"]yauzl['"]\)/);
  assert.match(modeNormalizerSource, /require\(['"]yazl['"]\)/);
  assert.doesNotMatch(
    modeNormalizerSource,
    /readUInt(?:16|32)LE|central directory|end.of.central.directory|0x0?6054b50/i,
  );
  const clientPackage = JSON.parse(
    await readFile(join(repositoryRoot, 'client/package.json'), 'utf8'),
  );
  assert.equal(clientPackage.scripts.build, 'tsc -p . && node ../scripts/build.mjs');
  const rootPackage = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(rootPackage.devDependencies.yauzl, '3.4.0');
  assert.equal(rootPackage.devDependencies.yazl, '2.5.1');
  assert.equal(
    rootPackage.scripts['check:artifacts'],
    'node --test scripts/bundled-third-party-notices.test.mjs scripts/runtime-artifacts.test.mjs scripts/vsix-file-modes.test.mjs',
  );
});

test('both bundles are minified, retain source maps, and feed their metafiles to notices', async () => {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const buildSource = await readFile(join(repositoryRoot, 'scripts/build.mjs'), 'utf8');
  const commonOptions = buildSource.match(/const common = \{([\s\S]*?)\n\};/)?.[1];

  assert(commonOptions, 'build must declare shared esbuild options');
  assert.match(commonOptions, /\babsWorkingDir:\s*monorepoRoot,/);
  assert.match(commonOptions, /\bminify:\s*true,/);
  assert.match(commonOptions, /\bsourcemap:\s*true,/);
  assert.match(commonOptions, /\bmetafile:\s*true,/);
  assert.equal(buildSource.match(/\.\.\.common,/g)?.length, 2);
  assert.match(
    buildSource,
    /metafiles:\s*\[extensionResult\.metafile, serverResult\.metafile\],/,
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'usn-runtime-artifacts-'));
  const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
  const files = new Map([
    ['client/package.json', `${JSON.stringify({ name: 'fixture' })}${' '.repeat(64)}`],
    ['client/README.md', 'r'.repeat(64)],
    ['client/CHANGELOG.md', 'c'.repeat(64)],
    ['client/LICENSE', 'l'.repeat(64)],
    ['client/images/icon.png', 'i'.repeat(64)],
    ['client/language-configuration/shader.json', 's'.repeat(64)],
    ['client/language-configuration/hlsl.json', 'h'.repeat(64)],
    ['client/out/THIRD_PARTY_NOTICES.txt', 'n'.repeat(64)],
    ['server/src/server.ts', 'server source'],
    ['server/out/server.js', Buffer.alloc(2_048, 's')],
    ['server/out/parser/runtimeAssets.js', 'runtime assets module'],
    ['server/grammars/tree-sitter-hlsl.wasm', Buffer.alloc(2_048, 'g')],
    ['server/grammars/tree-sitter-hlsl.provenance.json', 'p'.repeat(64)],
    ['server/grammars/tree-sitter-hlsl.LICENSE', 'l'.repeat(64)],
    ['server/grammars/extra-grammar-fact.txt', 'grammar-extra'],
    ['node_modules/web-tree-sitter/LICENSE', 'l'.repeat(64)],
    ['node_modules/web-tree-sitter/package.json', 'p'.repeat(64)],
    ['node_modules/web-tree-sitter/tree-sitter.js', Buffer.alloc(2_048, 'j')],
    ['node_modules/web-tree-sitter/tree-sitter.wasm', Buffer.alloc(2_048, 'w')],
    ['node_modules/web-tree-sitter/tree-sitter-web.d.ts', 'runtime-extra'],
    [
      'node_modules/vscode-languageclient/lib/node/terminateProcess.sh',
      '#!/bin/sh\nprintf \'%s\' "$1" > "$USN_TERMINATOR_MARKER"\n',
    ],
  ]);
  for (const [relativePath, contents] of files) {
    await write(join(root, relativePath), contents);
  }
  return {
    root,
    graph,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
