import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectPath = join(
  repositoryRoot,
  'tools',
  'gpu-capture-prototype',
  'UnityProject',
);
const descriptorPath = join(
  projectPath,
  'Library',
  'UnityShaderNavAdapter',
  'session.json',
);
const generatedAdapterRoot = join(
  projectPath,
  'Assets',
  'UnityShaderNavVisualLabFixture',
);
const generatedAdapterMarker = join(
  generatedAdapterRoot,
  '.unity-shader-nav-generated',
);
const generatedAdapterDll = join(
  generatedAdapterRoot,
  'Editor',
  'UnityShaderNav.Adapter.Editor.dll',
);
const generatedResponseFile = join(
  projectPath,
  'Library',
  'UnityShaderNavVisualLab',
  'Adapter.rsp',
);
const require = createRequire(import.meta.url);

function usage() {
  return [
    'Usage: node scripts/visual-lab-prototype.mjs --run [--unity <path>]',
    '',
    '  --run             Run two real Unity-rendered Visual Lab requests',
    '  --unity <path>    Unity executable (or set UNITY_PATH)',
    '  --help            Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  let run = false;
  let unity = process.env.UNITY_PATH;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') return null;
    if (argument === '--run') run = true;
    else if (argument === '--unity') {
      unity = argv[++index];
      if (!unity) throw new Error('--unity requires a path.');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!run) throw new Error('--run is required.');
  unity ||= discoverUnity();
  if (!unity || !existsSync(unity)) {
    throw new Error('Unity was not found; pass --unity or set UNITY_PATH.');
  }
  return { unity };
}

function discoverUnity() {
  const roots = [
    '/Applications/Unity/Hub/Editor',
    join(homedir(), 'Applications', 'Unity', 'Hub', 'Editor'),
  ];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root)) {
      candidates.push(join(
        root,
        version,
        'Unity.app',
        'Contents',
        'MacOS',
        'Unity',
      ));
    }
  }
  return candidates.sort().reverse().find(existsSync);
}

function loadRuntime() {
  const connectionModule = join(
    repositoryRoot,
    'server',
    'out',
    'adapter',
    'ipc',
    'rpcConnection.js',
  );
  const descriptorModule = join(
    repositoryRoot,
    'server',
    'out',
    'adapter',
    'ipc',
    'sessionDescriptor.js',
  );
  const validationModule = join(
    repositoryRoot,
    'server',
    'out',
    'adapter',
    'visualLabSource.js',
  );
  for (const artifact of [
    connectionModule,
    descriptorModule,
    validationModule,
  ]) {
    if (!existsSync(artifact)) {
      throw new Error(
        'Built server artifacts are missing; run npm run build first.',
      );
    }
  }
  const { AdapterRpcConnection } = require(connectionModule);
  const { discoverAdapterSession } = require(descriptorModule);
  const {
    validateVisualLabFrameEvidence,
    validateVisualLabTargetDescription,
  } = require(validationModule);
  return {
    AdapterRpcConnection,
    discoverAdapterSession,
    validateVisualLabFrameEvidence,
    validateVisualLabTargetDescription,
  };
}

function unityContents(unity) {
  return resolve(unity, '..', '..');
}

function editorResponseFiles(directory, found = []) {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) editorResponseFiles(path, found);
    else if (entry.name === 'Assembly-CSharp-Editor.rsp') found.push(path);
  }
  return found;
}

function latestEditorResponseFile() {
  const candidates = editorResponseFiles(join(
    projectPath,
    'Library',
    'Bee',
    'artifacts',
  ));
  return candidates.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
  )[0];
}

async function runUnityBootstrap(unity, timeoutMs = 300_000) {
  const child = spawn(unity, [
    '-noUpm',
    '-batchmode',
    '-projectPath',
    projectPath,
    '-quit',
    '-logFile',
    '-',
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const observe = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      lines.push(line);
      if (lines.length > 200) lines.shift();
    }
  };
  child.stdout.on('data', observe);
  child.stderr.on('data', observe);
  const exitCode = await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(timeoutMs).then(() => 'timeout'),
  ]);
  if (exitCode === 'timeout') {
    child.kill('SIGTERM');
    throw new Error('Unity fixture bootstrap timed out.');
  }
  if (exitCode !== 0) {
    throw new Error(
      `Unity fixture bootstrap exited with ${exitCode}.\n`
      + lines.slice(-80).join('\n'),
    );
  }
}

async function compileFixtureAdapter(unity) {
  let responseFile = latestEditorResponseFile();
  if (!responseFile) {
    await runUnityBootstrap(unity);
    responseFile = latestEditorResponseFile();
  }
  if (!responseFile) {
    throw new Error('Unity did not produce an Editor compilation response.');
  }
  if (existsSync(generatedAdapterRoot)) {
    const owned = existsSync(generatedAdapterMarker)
      && readFileSync(generatedAdapterMarker, 'utf8')
        === 'UnityShaderNav Visual Lab generated fixture\n';
    if (!owned) {
      throw new Error(
        'Refusing to replace an unowned Visual Lab fixture directory.',
      );
    }
    rmSync(generatedAdapterRoot, { recursive: true, force: true });
  }
  mkdirSync(join(generatedAdapterRoot, 'Editor'), { recursive: true });
  writeFileSync(
    generatedAdapterMarker,
    'UnityShaderNav Visual Lab generated fixture\n',
    'utf8',
  );
  mkdirSync(resolve(generatedResponseFile, '..'), { recursive: true });
  const response = readFileSync(responseFile, 'utf8')
    .split(/\r?\n/)
    .filter((line) => (
      line.length > 0
      && !line.includes('UnityShaderNavVisualLabFixture')
      && !/^-out:/i.test(line)
      && !/^-refout:/i.test(line)
      && !/^-analyzer:/i.test(line)
      && !/^\/additionalfile:/i.test(line)
      && !/^(?:"[^"]+\.cs"|[^\s]+\.cs)$/i.test(line)
    ))
    .join('\n');
  writeFileSync(generatedResponseFile, `${response}\n`, 'utf8');

  const contents = unityContents(unity);
  const compiler = join(contents, 'DotNetSdkRoslyn', 'csc.dll');
  const dotnet = join(contents, 'NetCoreRuntime', 'dotnet');
  const sources = readdirSync(join(repositoryRoot, 'unity-adapter', 'Editor'))
    .filter((name) => name.endsWith('.cs'))
    .sort()
    .map((name) => join(repositoryRoot, 'unity-adapter', 'Editor', name));
  const result = spawnSync(dotnet, [
    'exec',
    compiler,
    '/nostdlib',
    '/noconfig',
    '/shared',
    `@${generatedResponseFile}`,
    `/out:${generatedAdapterDll}`,
    ...sources,
  ], {
    cwd: projectPath,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(generatedAdapterDll)) {
    throw new Error(
      `Unity Adapter fixture compilation failed with ${result.status}.\n`
      + [result.stdout, result.stderr].filter(Boolean).join('\n'),
    );
  }
}

function removeFixtureAdapter() {
  if (
    existsSync(generatedAdapterMarker)
    && readFileSync(generatedAdapterMarker, 'utf8')
      === 'UnityShaderNav Visual Lab generated fixture\n'
  ) {
    rmSync(generatedAdapterRoot, { recursive: true, force: true });
    rmSync(`${generatedAdapterRoot}.meta`, { force: true });
  }
  rmSync(generatedResponseFile, { force: true });
}

function launchUnity(unity) {
  rmSync(descriptorPath, { force: true });
  const child = spawn(unity, [
    '-noUpm',
    '-batchmode',
    '-projectPath',
    projectPath,
    '-executeMethod',
    'UnityShaderNav.VisualLabPrototype.VisualLabPrototype.SelectProbeMaterial',
    '-logFile',
    '-',
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const observe = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      lines.push(line);
      if (lines.length > 400) lines.shift();
      if (line.includes('[UnityShaderNav')) {
        process.stdout.write(`${line}\n`);
      }
    }
  };
  child.stdout.on('data', observe);
  child.stderr.on('data', observe);
  return { child, lines };
}

async function delay(milliseconds) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForDescriptor(runtime, launched, timeoutMs = 300_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (launched.child.exitCode !== null) {
      throw new Error(
        `Unity exited with ${launched.child.exitCode} before Adapter discovery.\n`
        + launched.lines.slice(-80).join('\n'),
      );
    }
    const discovery = await runtime.discoverAdapterSession(projectPath);
    if (discovery.status === 'available') return discovery.descriptor;
    await delay(250);
  }
  throw new Error(
    `Unity Adapter discovery timed out after ${timeoutMs} ms.\n`
    + launched.lines.slice(-80).join('\n'),
  );
}

async function waitForSelection(connection, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await connection.request(
      'material-context',
      'get-selected-material-context',
    );
    if (snapshot?.status === 'selected') return snapshot;
    await delay(100);
  }
  throw new Error('The controlled persistent Material was not selected.');
}

function selectionFrom(snapshot, descriptor) {
  return {
    selectionId: snapshot.selectionId,
    contextRevision: `prototype:${snapshot.shader.revision.contentHash}`,
    material: snapshot.material,
    source: snapshot.shader,
    requestedContext: {
      contextId: 'visual-lab-prototype:subshader-0:pass-0:fragment',
      shaderUri: snapshot.shader.revision.uri,
      subShaderIndex: 0,
      passIndex: 0,
      passName: 'VisualLabForward',
      stage: 'fragment',
      entryPoint: 'frag',
    },
    materialKeywords: [...snapshot.materialKeywords].sort((left, right) => {
      const leftKey = `${left.scope}\0${left.name}`;
      const rightKey = `${right.scope}\0${right.name}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
    adapter: {
      projectId: descriptor.projectHash,
      instanceId: descriptor.instanceId,
      adapterVersion: descriptor.adapterVersion,
      unityVersion: descriptor.unityVersion,
    },
  };
}

async function renderAndVerify(runtime, connection, target, slot, generation) {
  const request = {
    slot,
    requestGeneration: generation,
    target,
  };
  const frame = await connection.request(
    'visual-lab-render/v1',
    'render-preview',
    request,
  );
  const failure = runtime.validateVisualLabFrameEvidence(
    frame,
    request,
    Date.now() + 1_000,
  );
  if (failure) {
    throw new Error(`${slot} frame failed validation: ${failure}.`);
  }
  const mask = frame.diagnostic.nanInfMask;
  const bytes = Buffer.from(mask.data, 'base64');
  const nonBinary = bytes.find((value) => value !== 0 && value !== 255);
  if (
    target.profile.renderTarget.width !== 64
    || target.profile.renderTarget.height !== 64
    || mask.byteLength !== 64 * 64
    || bytes.length !== mask.byteLength
    || nonBinary !== undefined
    || mask.nanPixelCount !== 64
    || mask.infinitePixelCount !== 64
    || mask.maskedPixelCount !== 128
  ) {
    throw new Error(
      `${slot} mask did not match the exact 64 NaN + 64 Inf contract.`,
    );
  }
  const actualPngHash = createHash('sha256')
    .update(Buffer.from(frame.image.data, 'base64'))
    .digest('hex');
  if (actualPngHash !== frame.image.sha256) {
    throw new Error(`${slot} PNG hash does not match its evidence.`);
  }
  return frame;
}

async function stopExactChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise((resolveExit) => {
    child.once('exit', resolveExit);
  });
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(10_000).then(() => true),
  ]);
  if (timedOut && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function runPrototype(options) {
  const runtime = loadRuntime();
  try {
    await compileFixtureAdapter(options.unity);
  } catch (error) {
    removeFixtureAdapter();
    throw error;
  }
  const launched = launchUnity(options.unity);
  let connection;
  try {
    const descriptor = await waitForDescriptor(runtime, launched);
    connection = await runtime.AdapterRpcConnection.connect(descriptor, {
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
    });
    const material = await waitForSelection(connection);
    const selection = selectionFrom(material, descriptor);
    const describeRequest = { selection };
    const description = await connection.request(
      'visual-lab-render/v1',
      'describe-preview-target',
      describeRequest,
    );
    const descriptionFailure = runtime.validateVisualLabTargetDescription(
      description,
      describeRequest,
    );
    if (descriptionFailure) {
      throw new Error(
        `Visual Lab target failed validation: ${descriptionFailure}.`,
      );
    }
    const before = await renderAndVerify(
      runtime,
      connection,
      description.target,
      'before',
      1,
    );
    const after = await renderAndVerify(
      runtime,
      connection,
      description.target,
      'after',
      2,
    );
    process.stdout.write(
      'Visual Lab prototype: PASS — two explicit Unity frames, '
      + `${before.image.width}x${before.image.height}, `
      + `${before.diagnostic.nanInfMask.nanPixelCount} NaN pixels, `
      + `${before.diagnostic.nanInfMask.infinitePixelCount} Inf pixels, `
      + `Adapter ${description.target.adapter.instanceId}.\n`,
    );
    if (
      before.requestGeneration === after.requestGeneration
      || before.slot === after.slot
    ) {
      throw new Error('Before and After were not independent requests.');
    }
  } finally {
    connection?.close();
    await stopExactChild(launched.child);
    removeFixtureAdapter();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n`
      + `${usage()}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    await runPrototype(options);
  } catch (error) {
    process.stderr.write(
      `Visual Lab prototype failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

await main();
