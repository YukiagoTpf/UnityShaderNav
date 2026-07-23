import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const projectPath = join(
  repositoryRoot,
  'tools',
  'gpu-capture-prototype',
  'UnityProject',
);
const outputDirectory = join(
  projectPath,
  'Library',
  'UnityShaderNavGpuCapture',
);

function usage() {
  return [
    'Usage: node scripts/gpu-capture-prototype.mjs [--preflight|--capture] [--unity <path>]',
    '',
    '  --preflight       Verify macOS/arm64, Xcode, Metal, and optional Unity',
    '  --capture         Run the isolated Unity project and verify captured evidence',
    '  --unity <path>    Unity executable (or set UNITY_PATH)',
    '  --help            Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  let mode = 'preflight';
  let unity = process.env.UNITY_PATH;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') return null;
    if (argument === '--preflight') mode = 'preflight';
    else if (argument === '--capture') mode = 'capture';
    else if (argument === '--unity') {
      unity = argv[++index];
      if (!unity) throw new Error('--unity requires a path.');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { mode, unity: unity || discoverUnity() };
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

function run(command, args, options = {}) {
  const { timeout = 30_000, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    killSignal: 'SIGTERM',
    ...spawnOptions,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${command} timed out after ${timeout} ms.`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${command} exited with ${result.status}${output ? `\n${output}` : ''}`,
    );
  }
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function preflight(unity, requireUnity) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The accepted prototype requires macOS on arm64.');
  }
  const xcode = run('xcodebuild', ['-version']).stdout.split(/\r?\n/);
  const version = /^Xcode (.+)$/.exec(xcode[0])?.[1];
  const buildVersion = /^Build version (.+)$/.exec(xcode[1])?.[1];
  if (!version || !buildVersion) {
    throw new Error('xcodebuild returned an unsupported version format.');
  }
  const metal = run('xcrun', ['metal', '--version']).stdout.split(/\r?\n/)[0];
  if (!metal) throw new Error('xcrun metal did not report a version.');
  const operatingSystemVersion = run('sw_vers', ['-productVersion']).stdout;
  const operatingSystemBuild = run('sw_vers', ['-buildVersion']).stdout;
  if (!operatingSystemVersion || !operatingSystemBuild) {
    throw new Error('sw_vers did not report a complete macOS identity.');
  }
  const displays = JSON.parse(
    run('system_profiler', ['SPDisplaysDataType', '-json']).stdout,
  )?.SPDisplaysDataType;
  const gpu = Array.isArray(displays)
    ? displays.find((value) => value?.sppci_device_type === 'spdisplays_gpu')
    : undefined;
  const gpuName = gpu?.sppci_model ?? gpu?._name;
  if (typeof gpuName !== 'string' || gpuName.trim().length === 0) {
    throw new Error('system_profiler did not report a GPU identity.');
  }

  let unityVersion;
  let unityBinaryVersion;
  if (unity) {
    if (!existsSync(unity)) throw new Error(`Unity executable not found: ${unity}`);
    unityBinaryVersion = run(unity, ['-version']).stdout;
    unityVersion = /^\d+\.\d+\.\d+[abfp]\d+/.exec(unityBinaryVersion)?.[0];
    if (unityVersion !== '2022.3.62f1') {
      throw new Error(
        `Prototype is pinned to Unity 2022.3.62f1; found ${unityBinaryVersion}.`,
      );
    }
  } else if (requireUnity) {
    throw new Error('Unity was not found; pass --unity or set UNITY_PATH.');
  }
  return {
    version,
    buildVersion,
    metal,
    operatingSystemVersion,
    operatingSystemBuild,
    gpuName: gpuName.trim(),
    unityVersion,
    unityBinaryVersion,
  };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    const facts = preflight(options.unity, options.mode === 'capture');
    process.stdout.write(
      `GPU capture preflight: PASS — macOS/arm64, Xcode ${facts.version} `
      + `(${facts.buildVersion}), ${facts.metal}\n`,
    );
    if (facts.unityVersion) {
      process.stdout.write(`Unity: ${facts.unityBinaryVersion}\n`);
    }
    if (options.mode !== 'capture') return;

    const evidence = join(outputDirectory, 'CaptureProbe.evidence.json');
    const trace = join(outputDirectory, 'CaptureProbe.gputrace');
    const captureInstanceId = randomUUID();
    const captureStartedAt = Date.now();
    rmSync(evidence, { force: true });
    rmSync(trace, { recursive: true, force: true });
    const capture = run(options.unity, [
      '-noUpm',
      '-batchmode',
      '-enable-metal-capture',
      '-projectPath',
      projectPath,
      '-executeMethod',
      'UnityShaderNav.GpuCapturePrototype.GpuCapturePrototype.Capture',
      '-quit',
      '-logFile',
      '-',
    ], {
      timeout: 300_000,
      env: {
        ...process.env,
        MTL_CAPTURE_ENABLED: '1',
        USN_XCODE_VERSION: facts.version,
        USN_XCODE_BUILD_VERSION: facts.buildVersion,
        USN_MACOS_VERSION: facts.operatingSystemVersion,
        USN_MACOS_BUILD_VERSION: facts.operatingSystemBuild,
        USN_METAL_VERSION: facts.metal,
        USN_UNITY_BINARY_VERSION: facts.unityBinaryVersion,
        USN_CAPTURE_INSTANCE_ID: captureInstanceId,
      },
    });
    const captureSummary = capture.stdout
      .split(/\r?\n/)
      .filter((line) => line.includes('[UnityShaderNav GPU capture]'));
    for (const line of captureSummary) process.stdout.write(`${line}\n`);
    if (captureSummary.length === 0) {
      process.stdout.write('Unity capture command completed successfully.\n');
    }

    if (!existsSync(evidence) || !existsSync(trace)) {
      throw new Error('Unity completed without producing evidence and a GPU trace.');
    }
    const capturedEvidence = JSON.parse(readFileSync(evidence, 'utf8'));
    if (
      capturedEvidence?.provenance?.instanceId !== captureInstanceId
      || capturedEvidence?.provenance?.collectedAt < captureStartedAt
    ) {
      throw new Error('Unity capture evidence does not belong to this invocation.');
    }
    const operatingSystemIdentity =
      `${facts.operatingSystemVersion} (${facts.operatingSystemBuild})`;
    const gpuDriverVersion =
      `OS build ${facts.operatingSystemBuild}; ${facts.metal}`;
    const shaderMeta = readFileSync(
      join(projectPath, 'Assets', 'Shaders', 'CaptureProbe.shader.meta'),
      'utf8',
    );
    const assetGuid = /^guid: ([a-f0-9]+)$/m.exec(shaderMeta)?.[1];
    if (!assetGuid) throw new Error('CaptureProbe.shader.meta has no asset GUID.');
    const verification = run('npm', [
      '--silent',
      'run',
      'check:gpu-capture-prototype',
      '--',
      '--evidence',
      evidence,
      '--source',
      join(projectPath, 'Assets', 'Shaders', 'CaptureProbe.shader'),
      '--source-uri',
      'project://Assets/Shaders/CaptureProbe.shader',
      '--asset-guid',
      assetGuid,
      '--project-id',
      'gpu-capture-prototype',
      '--os-version',
      operatingSystemIdentity,
      '--gpu-name',
      facts.gpuName,
      '--gpu-driver',
      gpuDriverVersion,
      '--xcode-version',
      facts.version,
      '--xcode-build',
      facts.buildVersion,
      '--metal-version',
      facts.metal,
      '--unity-version',
      facts.unityVersion,
      '--unity-binary',
      facts.unityBinaryVersion,
      '--adapter-version',
      'prototype-1',
      '--trace',
      trace,
    ]);
    process.stdout.write(`${verification.stdout}\n`);
    if (verification.stderr) process.stderr.write(`${verification.stderr}\n`);
  } catch (error) {
    process.stderr.write(
      `GPU capture prototype failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

main();
