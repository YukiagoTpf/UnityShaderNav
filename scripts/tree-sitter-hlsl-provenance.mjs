export const PROVENANCE_PATH = 'server/grammars/tree-sitter-hlsl.provenance.json';
export const GRAMMAR_ARTIFACT_PATH = 'server/grammars/tree-sitter-hlsl.wasm';
export const GRAMMAR_LICENSE_PATH = 'server/grammars/tree-sitter-hlsl.LICENSE';

const SOURCE_REPOSITORY = 'https://github.com/tree-sitter-grammars/tree-sitter-hlsl.git';
const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';
const WASM_OPT_PATH = '/emsdk/upstream/bin/wasm-opt';
const TOOLCHAIN_BY_CLI = new Map([
  ['0.24.7', { image: 'docker.io/emscripten/emsdk', tag: '3.1.64' }],
]);

export function parseGrammarProvenance(input) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  const root = record(value, 'provenance');
  exactKeys(root, ['schemaVersion', 'source', 'toolchain', 'artifact'], 'provenance');
  equal(root.schemaVersion, 2, 'provenance.schemaVersion');

  const source = record(root.source, 'provenance.source');
  exactKeys(
    source,
    ['repository', 'tag', 'commit', 'licensePath', 'licenseSha256'],
    'provenance.source',
  );
  equal(source.repository, SOURCE_REPOSITORY, 'provenance.source.repository');
  matches(source.tag, /^v\d+\.\d+\.\d+$/, 'provenance.source.tag');
  matches(source.commit, /^[0-9a-f]{40}$/, 'provenance.source.commit');
  equal(source.licensePath, GRAMMAR_LICENSE_PATH, 'provenance.source.licensePath');
  matches(source.licenseSha256, /^[0-9a-f]{64}$/, 'provenance.source.licenseSha256');

  const toolchain = record(root.toolchain, 'provenance.toolchain');
  exactKeys(toolchain, ['treeSitterCli', 'emscripten', 'wasmOpt'], 'provenance.toolchain');
  const cli = record(toolchain.treeSitterCli, 'provenance.toolchain.treeSitterCli');
  exactKeys(cli, ['version', 'integrity', 'registry'], 'provenance.toolchain.treeSitterCli');
  matches(cli.version, /^\d+\.\d+\.\d+$/, 'provenance.toolchain.treeSitterCli.version');
  validSha512Integrity(cli.integrity, 'provenance.toolchain.treeSitterCli.integrity');
  equal(cli.registry, PUBLIC_NPM_REGISTRY, 'provenance.toolchain.treeSitterCli.registry');

  const expectedToolchain = TOOLCHAIN_BY_CLI.get(cli.version);
  if (!expectedToolchain) {
    throw new Error(`provenance.toolchain: unsupported tree-sitter-cli ${JSON.stringify(cli.version)}`);
  }
  const emscripten = record(toolchain.emscripten, 'provenance.toolchain.emscripten');
  exactKeys(emscripten, ['image', 'tag', 'digest', 'platform'], 'provenance.toolchain.emscripten');
  equal(emscripten.image, expectedToolchain.image, 'provenance.toolchain.emscripten.image');
  equal(emscripten.tag, expectedToolchain.tag, 'provenance.toolchain.emscripten.tag');
  matches(emscripten.digest, /^sha256:[0-9a-f]{64}$/, 'provenance.toolchain.emscripten.digest');
  equal(emscripten.platform, 'linux/amd64', 'provenance.toolchain.emscripten.platform');

  const wasmOpt = record(toolchain.wasmOpt, 'provenance.toolchain.wasmOpt');
  exactKeys(wasmOpt, ['path', 'version', 'arguments'], 'provenance.toolchain.wasmOpt');
  equal(wasmOpt.path, WASM_OPT_PATH, 'provenance.toolchain.wasmOpt.path');
  matches(
    wasmOpt.version,
    /^wasm-opt version [1-9]\d* \([A-Za-z0-9][A-Za-z0-9._+-]*\)$/,
    'provenance.toolchain.wasmOpt.version',
  );
  exactArray(wasmOpt.arguments, ['-Oz'], 'provenance.toolchain.wasmOpt.arguments');

  const artifact = record(root.artifact, 'provenance.artifact');
  exactKeys(artifact, ['path', 'unoptimized', 'size', 'sha256'], 'provenance.artifact');
  equal(artifact.path, GRAMMAR_ARTIFACT_PATH, 'provenance.artifact.path');
  const unoptimized = record(artifact.unoptimized, 'provenance.artifact.unoptimized');
  exactKeys(unoptimized, ['size', 'sha256'], 'provenance.artifact.unoptimized');
  if (!Number.isSafeInteger(unoptimized.size) || unoptimized.size <= 0) {
    throw new Error('provenance.artifact.unoptimized.size: expected a positive safe integer');
  }
  matches(
    unoptimized.sha256,
    /^[0-9a-f]{64}$/,
    'provenance.artifact.unoptimized.sha256',
  );
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    throw new Error('provenance.artifact.size: expected a positive safe integer');
  }
  if (artifact.size >= unoptimized.size) {
    throw new Error(
      'provenance.artifact.size: expected wasm-opt output to be smaller than the unoptimized artifact',
    );
  }
  matches(artifact.sha256, /^[0-9a-f]{64}$/, 'provenance.artifact.sha256');

  return root;
}

function validSha512Integrity(value, label) {
  matches(value, /^sha512-[A-Za-z0-9+/]+={0,2}$/, label);
  const encoded = value.slice('sha512-'.length);
  const digest = Buffer.from(encoded, 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== encoded) {
    throw new Error(`${label}: expected canonical base64 for exactly 64 digest bytes`);
  }
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label}: expected keys ${wanted.join(', ')}, received ${actual.join(', ')}`);
  }
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || (
    value.some((item, index) => item !== expected[index])
  )) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(value)}`);
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function matches(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label}: invalid value ${JSON.stringify(value)}`);
  }
}
