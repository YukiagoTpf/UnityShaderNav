import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import runtimeArtifacts from './runtime-artifacts.cjs';

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
    for (const watchInput of fixture.graph.watchInputs) {
      assert(
        fixture.graph.manifestInputs.includes(watchInput),
        `manifest must track watch input ${watchInput}`,
      );
    }
    assert(fixture.graph.requiredOutputFiles.includes('client/out/runtime-artifacts.json'));
    assert(fixture.graph.requiredVsixEntries.includes('extension/CHANGELOG.md'));
    assert(fixture.graph.requiredVsixEntries.includes('extension/out/runtime-artifacts.json'));
  } finally {
    await fixture.cleanup();
  }
});

test('content manifest rejects changed runtime outputs and changed build inputs', async () => {
  const fixture = await createFixture();
  try {
    await runtimeArtifacts.assembleCopiedServerRuntime(fixture.graph);
    await write(join(fixture.root, 'client/out/extension.js'), 'extension bundle');
    await write(join(fixture.root, 'client/out/server/server.js'), 'server bundle');
    await runtimeArtifacts.writeRuntimeArtifactManifest(fixture.graph);
    await runtimeArtifacts.verifyRuntimeArtifactManifest(fixture.graph);

    await write(join(fixture.root, 'client/out/server/extra.js'), 'unexpected output');
    await assert.rejects(
      runtimeArtifacts.verifyRuntimeArtifactManifest(fixture.graph),
      /runtime artifact output file set differs/,
    );
    await rm(join(fixture.root, 'client/out/server/extra.js'));

    await rm(join(
      fixture.root,
      'client/out/server/node_modules/web-tree-sitter/tree-sitter.js',
    ));
    await assert.rejects(
      runtimeArtifacts.verifyRuntimeArtifactManifest(fixture.graph),
      /runtime artifact output file set differs/,
    );
    await runtimeArtifacts.assembleRuntimeSupport(fixture.graph);

    await write(
      join(fixture.root, 'client/out/server/node_modules/web-tree-sitter/tree-sitter.wasm'),
      'changed output bytes',
    );
    await assert.rejects(
      runtimeArtifacts.verifyRuntimeArtifactManifest(fixture.graph),
      /runtime artifact output bytes differ.*tree-sitter\.wasm/,
    );

    await runtimeArtifacts.assembleRuntimeSupport(fixture.graph);
    await runtimeArtifacts.writeRuntimeArtifactManifest(fixture.graph);
    await write(join(fixture.root, 'server/src/server.ts'), 'changed input bytes');
    await assert.rejects(
      runtimeArtifacts.verifyRuntimeArtifactManifest(fixture.graph),
      /runtime artifact input bytes differ.*server\/src\/server\.ts/,
    );
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
  const clientPackage = JSON.parse(
    await readFile(join(repositoryRoot, 'client/package.json'), 'utf8'),
  );
  assert.equal(clientPackage.scripts.build, 'tsc -p . && node ../scripts/build.mjs');
});

test('manifest parser rejects path escapes and incomplete packaged artifacts', () => {
  const hash = 'a'.repeat(64);
  assert.throws(
    () => runtimeArtifacts.parseRuntimeArtifactManifest(JSON.stringify({
      schemaVersion: 1,
      inputs: { '../outside': hash },
      artifacts: { 'client/out/extension.js': hash },
      packagedArtifacts: { 'client/out/extension.js': hash },
    })),
    /unsupported shape/,
  );
  assert.throws(
    () => runtimeArtifacts.parseRuntimeArtifactManifest(JSON.stringify({
      schemaVersion: 1,
      inputs: { 'client/src/extension.ts': hash },
      artifacts: {
        'client/out/extension.js': hash,
        'client/out/server/server.js': hash,
      },
      packagedArtifacts: { 'client/out/extension.js': hash },
    })),
    /packaged output file set differs/,
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'usn-runtime-artifacts-'));
  const graph = runtimeArtifacts.createRuntimeArtifactGraph(root);
  const files = new Map([
    ['client/src/extension.ts', 'extension source'],
    ['client/package.json', '{}'],
    ['shared/src/index.ts', 'shared source'],
    ['server/src/server.ts', 'server source'],
    ['server/out/server.js', 'copied server'],
    ['server/out/parser/runtimeAssets.js', 'runtime assets module'],
    ['server/package.json', '{}'],
    ['shared/package.json', '{}'],
    ['shared/tsconfig.json', '{}'],
    ['tsconfig.base.json', '{}'],
    ['client/tsconfig.json', '{}'],
    ['server/tsconfig.json', '{}'],
    ['scripts/build.mjs', 'build'],
    ['scripts/runtime-artifacts.cjs', 'artifact module'],
    ['server/grammars/tree-sitter-hlsl.wasm', 'grammar'],
    ['server/grammars/tree-sitter-hlsl.provenance.json', '{}'],
    ['server/grammars/tree-sitter-hlsl.LICENSE', 'license'],
    ['server/grammars/extra-grammar-fact.txt', 'grammar-extra'],
    ['node_modules/web-tree-sitter/package.json', '{}'],
    ['node_modules/web-tree-sitter/tree-sitter.js', 'runtime'],
    ['node_modules/web-tree-sitter/tree-sitter.wasm', 'runtime wasm'],
    ['node_modules/web-tree-sitter/tree-sitter-web.d.ts', 'runtime-extra'],
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
