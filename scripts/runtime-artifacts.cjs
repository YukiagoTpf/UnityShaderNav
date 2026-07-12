'use strict';

const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { access, cp, lstat, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises');
const { dirname, relative, resolve, sep } = require('node:path');

const SCHEMA_VERSION = 1;

function createRuntimeArtifactGraph(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const bundles = [
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
  ];
  const supportTrees = [
    {
      id: 'hlsl-grammar',
      source: 'server/grammars',
      output: 'client/out/grammars',
      required: [
        'tree-sitter-hlsl.wasm',
        'tree-sitter-hlsl.provenance.json',
        'tree-sitter-hlsl.LICENSE',
      ],
    },
    {
      id: 'web-tree-sitter-runtime',
      source: 'node_modules/web-tree-sitter',
      output: 'client/out/server/node_modules/web-tree-sitter',
      required: ['package.json', 'tree-sitter.js', 'tree-sitter.wasm'],
    },
  ];
  const freshnessChecks = [
    {
      output: bundles[0].output,
      inputs: [
        'client/src',
        'client/package.json',
        'shared/src',
        'tsconfig.base.json',
        'client/tsconfig.json',
        'scripts/build.mjs',
        'scripts/runtime-artifacts.cjs',
      ],
    },
    {
      output: bundles[1].output,
      inputs: [
        'server/src',
        'server/out',
        'server/package.json',
        'shared/src',
        'shared/package.json',
        'tsconfig.base.json',
        'server/tsconfig.json',
        'scripts/build.mjs',
        'scripts/runtime-artifacts.cjs',
      ],
    },
    ...supportTrees.flatMap((tree) => tree.required.map((entry) => ({
      output: `${tree.output}/${entry}`,
      inputs: [`${tree.source}/${entry}`, 'scripts/runtime-artifacts.cjs'],
    }))),
  ];
  const requiredOutputFiles = [
    ...bundles.map((bundle) => bundle.output),
    ...supportTrees.flatMap((tree) => (
      tree.required.map((entry) => `${tree.output}/${entry}`)
    )),
    'client/out/runtime-artifacts.json',
  ];
  const requiredVsixEntries = [
    'extension/package.json',
    'extension/README.md',
    'extension/LICENSE.txt',
    ...requiredOutputFiles.map(vsixEntryForOutput),
  ];
  const watchInputs = [
    'shared/src',
    'server/src',
    'client/src',
    ...supportTrees.map((tree) => tree.source),
    'tsconfig.base.json',
    'shared/tsconfig.json',
    'server/tsconfig.json',
    'client/tsconfig.json',
    'shared/package.json',
    'server/package.json',
    'client/package.json',
    'scripts/build.mjs',
    'scripts/runtime-artifacts.cjs',
  ];
  const manifestInputs = [...new Set([
    ...freshnessChecks.flatMap((check) => check.inputs),
    ...supportTrees.map((tree) => tree.source),
    ...watchInputs,
  ])];

  return Object.freeze({
    repositoryRoot: root,
    copiedServerSource: 'server/out',
    copiedServerOutput: 'client/out/server',
    manifest: 'client/out/runtime-artifacts.json',
    bundles: Object.freeze(bundles.map(Object.freeze)),
    extensionStagingPaths: Object.freeze([
      'package.json',
      'out',
      'images',
      'language-configuration',
    ]),
    parserRuntimeLayouts: Object.freeze([
      Object.freeze(['source', 'server/src/parser/runtimeAssets.ts']),
      Object.freeze(['tsc-out', 'server/out/parser/runtimeAssets.js']),
      Object.freeze(['copied-server', 'client/out/server/parser/runtimeAssets.js']),
      Object.freeze(['bundled-server', 'client/out/server/server.js']),
    ]),
    supportTrees: Object.freeze(supportTrees.map((tree) => Object.freeze({
      ...tree,
      required: Object.freeze([...tree.required]),
    }))),
    freshnessChecks: Object.freeze(freshnessChecks.map((check) => Object.freeze({
      output: check.output,
      inputs: Object.freeze([...check.inputs]),
    }))),
    manifestInputs: Object.freeze(manifestInputs),
    watchInputs: Object.freeze(watchInputs),
    requiredOutputFiles: Object.freeze(requiredOutputFiles),
    requiredVsixEntries: Object.freeze(requiredVsixEntries),
  });
}

async function assembleCopiedServerRuntime(graph) {
  const source = absolute(graph, graph.copiedServerSource);
  const output = absolute(graph, graph.copiedServerOutput);
  await assertFile(resolve(source, 'server.js'), 'server workspace output');
  await rm(output, { recursive: true, force: true });
  await cp(source, output, { recursive: true, force: true });
  await assembleRuntimeSupport(graph);
}

async function assembleRuntimeSupport(graph) {
  for (const tree of graph.supportTrees) {
    for (const entry of tree.required) {
      await assertFile(absolute(graph, `${tree.source}/${entry}`), `${tree.id} source`);
    }
    const output = absolute(graph, tree.output);
    await rm(output, { recursive: true, force: true });
    await cp(absolute(graph, tree.source), output, { recursive: true, force: true });
  }
}

async function writeRuntimeArtifactManifest(graph) {
  const artifacts = await snapshotArtifactOutputs(graph);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    inputs: await snapshotPaths(graph, graph.manifestInputs),
    artifacts,
    packagedArtifacts: Object.fromEntries(
      Object.entries(artifacts).filter(([path]) => isPackagedOutput(path)),
    ),
  };
  await writeFile(
    absolute(graph, graph.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function assertFreshRuntimeArtifacts(graph) {
  await assertFreshOutputs(graph);
  return verifyRuntimeArtifactManifest(graph);
}

async function verifyRuntimeArtifactManifest(graph) {
  const manifest = parseManifest(await readFile(absolute(graph, graph.manifest), 'utf8'));
  const currentInputs = await snapshotPaths(graph, graph.manifestInputs);
  const currentArtifacts = await snapshotArtifactOutputs(graph);
  assertSnapshotEqual(manifest.inputs, currentInputs, 'runtime artifact input');
  assertSnapshotEqual(manifest.artifacts, currentArtifacts, 'runtime artifact output');
  return manifest;
}

async function assertFreshOutputs(graph) {
  for (const check of graph.freshnessChecks) {
    const outputPath = absolute(graph, check.output);
    const outputStat = await statOrThrow(
      outputPath,
      `${check.output} is missing; run npm run build before packaging`,
    );
    const newest = await newestInput(graph, check.inputs);
    if (outputStat.mtimeMs < newest.mtimeMs) {
      throw new Error(`${check.output} is stale; newest input ${newest.relativePath} is newer`);
    }
  }
}

async function snapshotArtifactOutputs(graph) {
  const paths = (await relativeFiles(graph, 'client/out'))
    .filter((path) => path !== graph.manifest);
  return snapshotPaths(graph, paths);
}

async function snapshotPaths(graph, inputPaths) {
  const files = new Set();
  for (const input of inputPaths) {
    const inputPath = absolute(graph, input);
    const inputStat = await lstat(inputPath);
    if (inputStat.isFile()) files.add(toPosix(relative(graph.repositoryRoot, inputPath)));
    else if (inputStat.isDirectory()) {
      for (const file of await relativeFiles(graph, input)) files.add(file);
    } else throw new Error(`runtime artifact inputs must not be symbolic links: ${input}`);
  }
  const snapshot = {};
  for (const file of [...files].sort()) {
    snapshot[file] = sha256(await readFile(absolute(graph, file)));
  }
  return snapshot;
}

async function relativeFiles(graph, rootRelative) {
  const root = absolute(graph, rootRelative);
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(toPosix(relative(graph.repositoryRoot, candidate)));
      else throw new Error(
        `runtime artifact trees must not contain symbolic links: ${toPosix(relative(graph.repositoryRoot, candidate))}`,
      );
    }
  }
  await visit(root);
  return files.sort();
}

async function newestInput(graph, inputPaths) {
  let newest = { mtimeMs: 0, relativePath: '' };
  for (const input of inputPaths) {
    const inputPath = absolute(graph, input);
    if (!existsSync(inputPath)) continue;
    const candidates = (await lstat(inputPath)).isFile()
      ? [toPosix(relative(graph.repositoryRoot, inputPath))]
      : await relativeFiles(graph, input);
    for (const file of candidates) {
      const fileStat = await stat(absolute(graph, file));
      if (fileStat.mtimeMs > newest.mtimeMs) {
        newest = { mtimeMs: fileStat.mtimeMs, relativePath: file };
      }
    }
  }
  if (!newest.relativePath) throw new Error(`No freshness inputs found for ${inputPaths.join(', ')}`);
  return newest;
}

function parseManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('runtime artifact manifest is invalid JSON', { cause: error });
  }
  if (
    !value
    || value.schemaVersion !== SCHEMA_VERSION
    || !isHashRecord(value.inputs)
    || !isHashRecord(value.artifacts)
    || !isHashRecord(value.packagedArtifacts)
  ) throw new Error('runtime artifact manifest has an unsupported shape');
  for (const [path, hash] of Object.entries(value.packagedArtifacts)) {
    if (value.artifacts[path] !== hash || !isPackagedOutput(path)) {
      throw new Error('runtime artifact manifest has invalid packaged artifacts');
    }
  }
  const expectedPackagedArtifacts = Object.fromEntries(
    Object.entries(value.artifacts).filter(([path]) => isPackagedOutput(path)),
  );
  assertSnapshotEqual(
    expectedPackagedArtifacts,
    value.packagedArtifacts,
    'runtime artifact packaged output',
  );
  return value;
}

function isHashRecord(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.entries(value).every(([path, hash]) => (
      isCanonicalRepositoryPath(path)
      && typeof hash === 'string'
      && /^[0-9a-f]{64}$/.test(hash)
    ));
}

function isCanonicalRepositoryPath(path) {
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function assertSnapshotEqual(expected, actual, label) {
  const expectedPaths = Object.keys(expected).sort();
  const actualPaths = Object.keys(actual).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error(`${label} file set differs from the build manifest`);
  }
  for (const path of expectedPaths) {
    if (expected[path] !== actual[path]) {
      throw new Error(`${label} bytes differ from the build manifest: ${path}`);
    }
  }
}

function assertRuntimeArtifactManifestsEqual(expected, actual) {
  assertSnapshotEqual(expected.inputs, actual.inputs, 'runtime artifact manifest input');
  assertSnapshotEqual(expected.artifacts, actual.artifacts, 'runtime artifact manifest output');
  assertSnapshotEqual(
    expected.packagedArtifacts,
    actual.packagedArtifacts,
    'runtime artifact manifest packaged output',
  );
}

function vsixEntryForOutput(output) {
  if (!output.startsWith('client/')) throw new Error(`Not a client output path: ${output}`);
  return `extension/${output.slice('client/'.length)}`;
}

function isPackagedOutput(path) {
  return !path.endsWith('.ts') && !path.endsWith('.map');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function absolute(graph, path) {
  return resolve(graph.repositoryRoot, path);
}

function toPosix(value) {
  return value.split(sep).join('/');
}

async function assertFile(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function statOrThrow(path, message) {
  try {
    return await stat(path);
  } catch {
    throw new Error(message);
  }
}

module.exports = {
  assembleCopiedServerRuntime,
  assembleRuntimeSupport,
  assertFreshRuntimeArtifacts,
  assertRuntimeArtifactManifestsEqual,
  createRuntimeArtifactGraph,
  parseRuntimeArtifactManifest: parseManifest,
  sha256RuntimeArtifact: sha256,
  verifyRuntimeArtifactManifest,
  vsixEntryForOutput,
  writeRuntimeArtifactManifest,
};
