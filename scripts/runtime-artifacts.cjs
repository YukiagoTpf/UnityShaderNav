'use strict';

const { access, cp, lstat, realpath, rm } = require('node:fs/promises');
const { isAbsolute, relative, resolve, sep } = require('node:path');

const MINIMUM_EXECUTABLE_BYTES = 1_024;
const MINIMUM_METADATA_BYTES = 32;

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
  const runtimeFiles = [
    ...bundles.map((bundle) => ({
      path: bundle.output,
      packagePath: packagePathForClientFile(bundle.output),
      minBytes: MINIMUM_EXECUTABLE_BYTES,
    })),
    ...supportTrees.flatMap((tree) => tree.required.map((entry) => {
      const path = `${tree.output}/${entry}`;
      return {
        path,
        packagePath: packagePathForClientFile(path),
        minBytes: entry.endsWith('.wasm') || entry.endsWith('.js')
          ? MINIMUM_EXECUTABLE_BYTES
          : MINIMUM_METADATA_BYTES,
      };
    })),
  ];
  const packageFiles = [
    ...runtimeFiles,
    ...[
      'client/package.json',
      'client/README.md',
      'client/CHANGELOG.md',
      'client/LICENSE',
      'client/language-configuration/shader.json',
      'client/language-configuration/hlsl.json',
    ].map((path) => ({
      path,
      packagePath: packagePathForClientFile(path),
      minBytes: MINIMUM_METADATA_BYTES,
    })),
  ];
  const requiredOutputFiles = runtimeFiles.map((file) => file.path);
  const requiredPackagePaths = packageFiles.map((file) => file.packagePath);
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
  return Object.freeze({
    repositoryRoot: root,
    copiedServerSource: 'server/out',
    copiedServerOutput: 'client/out/server',
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
    runtimeFiles: Object.freeze(runtimeFiles.map(Object.freeze)),
    packageFiles: Object.freeze(packageFiles.map(Object.freeze)),
    watchInputs: Object.freeze(watchInputs),
    requiredOutputFiles: Object.freeze(requiredOutputFiles),
    requiredPackagePaths: Object.freeze(requiredPackagePaths),
  });
}

async function assertRuntimeArtifacts(graph) {
  await assertSizedFiles(graph, graph.runtimeFiles);
}

async function assertPackageFiles(graph) {
  await assertSizedFiles(graph, graph.packageFiles);
}

async function assertPackagePlan(graph, plannedFiles) {
  const canonicalClientRoot = await realpath(absolute(graph, 'client'));
  const packagePaths = [...plannedFiles];
  const plannedPaths = new Set();

  for (const packagePath of packagePaths) {
    if (!isCanonicalPackagePath(packagePath)) {
      throw new Error(`VSCE package plan path is not canonical: ${String(packagePath)}`);
    }
    if (plannedPaths.has(packagePath)) {
      throw new Error(`VSCE package plan contains duplicate path ${packagePath}`);
    }
    plannedPaths.add(packagePath);
  }

  for (const packagePath of packagePaths) {
    const declaredPath = resolve(canonicalClientRoot, packagePath);
    let fileStat;
    let canonicalPath;
    try {
      fileStat = await lstat(declaredPath);
      canonicalPath = await realpath(declaredPath);
    } catch (error) {
      if (error && typeof error === 'object' && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
        throw new Error(`VSCE package plan file ${packagePath} is missing`);
      }
      throw new Error(`VSCE package plan file ${packagePath} could not be inspected`, {
        cause: error,
      });
    }
    if (!fileStat.isFile()) {
      throw new Error(`VSCE package plan file ${packagePath} must be a regular file`);
    }
    if (!isWithin(canonicalClientRoot, canonicalPath)) {
      throw new Error(`VSCE package plan file ${packagePath} escapes the extension root`);
    }
    if (packagePath.endsWith('.tsbuildinfo')) {
      throw new Error(`VSCE package plan must not include generated file ${packagePath}`);
    }
  }

  for (const packagePath of graph.requiredPackagePaths) {
    if (!plannedPaths.has(packagePath)) {
      throw new Error(`VSCE package plan is missing required file ${packagePath}`);
    }
  }
}

async function assertSizedFiles(graph, files) {
  const canonicalRoot = await realpath(graph.repositoryRoot);
  for (const file of files) {
    const declaredPath = absolute(graph, file.path);
    let fileStat;
    let canonicalPath;
    try {
      [fileStat, canonicalPath] = await Promise.all([
        lstat(declaredPath),
        realpath(declaredPath),
      ]);
    } catch (error) {
      if (error && typeof error === 'object' && ['ENOENT', 'ENOTDIR'].includes(error.code)) {
        throw new Error(`${file.path} is missing`);
      }
      throw new Error(`${file.path} could not be inspected`, { cause: error });
    }
    if (!fileStat.isFile()) throw new Error(`${file.path} must be a regular file`);
    if (!isWithin(canonicalRoot, canonicalPath)) {
      throw new Error(`${file.path} escapes the repository root`);
    }
    if (fileStat.size < file.minBytes) {
      throw new Error(
        `${file.path} is truncated: ${fileStat.size} bytes; expected at least ${file.minBytes}`,
      );
    }
  }
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (!isAbsolute(pathFromRoot)
      && pathFromRoot !== '..'
      && !pathFromRoot.startsWith(`..${sep}`));
}

function isCanonicalPackagePath(packagePath) {
  if (typeof packagePath !== 'string' || packagePath.length === 0) return false;
  if (packagePath.startsWith('/') || packagePath.includes('\\') || packagePath.includes('\0')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(packagePath)) return false;
  return packagePath.split('/').every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..'
  ));
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

function packagePathForClientFile(path) {
  if (!path.startsWith('client/')) throw new Error(`Not a client path: ${path}`);
  return path.slice('client/'.length);
}

function absolute(graph, path) {
  return resolve(graph.repositoryRoot, path);
}

async function assertFile(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

module.exports = {
  assembleCopiedServerRuntime,
  assembleRuntimeSupport,
  assertPackageFiles,
  assertPackagePlan,
  assertRuntimeArtifacts,
  createRuntimeArtifactGraph,
};
