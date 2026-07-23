import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  GpuCaptureCorrelationResult,
  GpuCaptureReplayEnvironment,
  GpuCaptureTraceVerification,
} from '@unity-shader-nav/shared';
import { correlateGpuCaptureEvidence } from './gpuCaptureCorrelation';
import { verifyLocalGpuTrace } from './gpuCaptureTrace';

interface Options {
  readonly evidence: string;
  readonly source: string;
  readonly sourceUri: string;
  readonly assetGuid: string;
  readonly projectId: string;
  readonly operatingSystemVersion: string;
  readonly gpuName: string;
  readonly gpuDriverVersion: string;
  readonly xcodeVersion: string;
  readonly xcodeBuildVersion: string;
  readonly metalCompilerVersion: string;
  readonly unityVersion: string;
  readonly unityBinaryVersion: string;
  readonly adapterVersion: string;
  readonly json: string;
  readonly trace?: string;
  readonly sanitizedFixture: boolean;
}

const FIXTURE_ROOT = 'server/tests/adapter/fixtures/gpu-capture';
const PROTOTYPE_SOURCE =
  'tools/gpu-capture-prototype/UnityProject/Assets/Shaders/CaptureProbe.shader';

function usage(): string {
  return [
    'Usage: npm run check:gpu-capture-prototype -- [options]',
    '',
    'Options:',
    `  --evidence <path>     Sanitized evidence (default: ${FIXTURE_ROOT}/CaptureProbe.evidence.json)`,
    `  --source <path>       Exact Shader source (default: ${PROTOTYPE_SOURCE})`,
    '  --source-uri <uri>    Adapter source identity',
    '  --asset-guid <guid>   Current Unity asset GUID',
    '  --project-id <id>     Expected Unity project identity',
    '  --os-version <value>  Exact macOS version/build identity',
    '  --gpu-name <value>    Exact GPU identity',
    '  --gpu-driver <value>  Exact OS-coupled GPU driver identity',
    '  --xcode-version <ver> Exact Xcode version',
    '  --xcode-build <build> Exact Xcode build',
    '  --metal-version <ver> Exact Metal compiler/toolchain version',
    '  --unity-version <ver> Exact capture Unity version',
    '  --unity-binary <value> Exact selected Unity binary identity',
    '  --adapter-version <v> Exact capture Adapter version',
    '  --trace <path>        Verify a real local .gputrace hash, size, and draw label',
    '  --sanitized-fixture   Explicitly verify bounded fixture without a raw trace',
    '  --json <path|->       Machine report path or stdout',
    '  --help                Show this help',
  ].join('\n');
}

function args(argv: readonly string[]): Options | null {
  const values: Record<string, string> = {
    evidence: `${FIXTURE_ROOT}/CaptureProbe.evidence.json`,
    source: PROTOTYPE_SOURCE,
    sourceUri: 'project://Assets/Shaders/CaptureProbe.shader',
    assetGuid: 'f14aeb7b969724b9797221308d626ee8',
    projectId: 'gpu-capture-prototype',
    operatingSystemVersion: '26.3 (25D125)',
    gpuName: 'Apple M4 Pro',
    gpuDriverVersion:
      'OS build 25D125; Apple metal version 32023.883 (metalfe-32023.883)',
    xcodeVersion: '26.6',
    xcodeBuildVersion: '17F113',
    metalCompilerVersion:
      'Apple metal version 32023.883 (metalfe-32023.883)',
    unityVersion: '2022.3.62f1',
    unityBinaryVersion: '2022.3.62f1',
    adapterVersion: 'prototype-1',
    json: 'Library/UnityShaderNavReports/gpu-capture-correlation-report.json',
  };
  const names: Record<string, keyof typeof values> = {
    '--evidence': 'evidence',
    '--source': 'source',
    '--source-uri': 'sourceUri',
    '--asset-guid': 'assetGuid',
    '--project-id': 'projectId',
    '--os-version': 'operatingSystemVersion',
    '--gpu-name': 'gpuName',
    '--gpu-driver': 'gpuDriverVersion',
    '--xcode-version': 'xcodeVersion',
    '--xcode-build': 'xcodeBuildVersion',
    '--metal-version': 'metalCompilerVersion',
    '--unity-version': 'unityVersion',
    '--unity-binary': 'unityBinaryVersion',
    '--adapter-version': 'adapterVersion',
    '--json': 'json',
  };
  let trace: string | undefined;
  let customCaptureInput = false;
  let explicitSanitizedFixture = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') return null;
    if (argument === '--sanitized-fixture') {
      explicitSanitizedFixture = true;
      continue;
    }
    if (argument === '--trace') {
      trace = argv[++index];
      if (!trace) throw new Error('--trace requires a value.');
      customCaptureInput = true;
      continue;
    }
    const name = names[argument];
    if (!name) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[++index];
    if (!value) throw new Error(`${argument} requires a value.`);
    values[name] = value;
    if (argument !== '--json') customCaptureInput = true;
  }
  if (explicitSanitizedFixture && customCaptureInput) {
    throw new Error(
      '--sanitized-fixture cannot be combined with custom capture inputs or --trace.',
    );
  }
  const sanitizedFixture = !customCaptureInput;
  if (!sanitizedFixture && !trace) {
    throw new Error(
      'Custom capture inputs require --trace; use --sanitized-fixture only for bounded tests.',
    );
  }
  return {
    ...(values as unknown as Omit<Options, 'trace' | 'sanitizedFixture'>),
    ...(trace ? { trace } : {}),
    sanitizedFixture,
  };
}

function human(result: GpuCaptureCorrelationResult): string {
  const lines = [`GPU capture correlation: ${result.status.toUpperCase()}`];
  if (result.status === 'current') {
    lines.push(
      `Capture: ${result.evidence.draw.captureId} — ${result.evidence.draw.label}`,
      `Context: ${result.context.shaderName} / Pass ${result.context.passIndex}`
        + `${result.context.passName ? ` ${result.context.passName}` : ''}`
        + ` / ${result.context.stage} ${result.context.entryPoint}`,
      `Source: ${result.uri}:${result.range.start.line + 1}:`
        + `${result.range.start.character + 1}`,
      `Trace: ${result.evidence.draw.trace.fileName} `
        + `(${result.evidence.draw.trace.storage}; ${result.traceStatus}; `
        + 'not repository-owned)',
    );
  } else {
    lines.push(`Reason: ${result.reason}`);
    if ('detail' in result) lines.push(`Detail: ${result.detail}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  let options: Options | null;
  try {
    options = args(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    process.exitCode = 3;
    return;
  }
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let evidence: unknown;
  let sourceText: string;
  try {
    evidence = JSON.parse(await readFile(resolve(options.evidence), 'utf8'));
    sourceText = await readFile(resolve(options.source), 'utf8');
  } catch (error) {
    process.stderr.write(
      `GPU capture input cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 3;
    return;
  }
  const replayEnvironment: GpuCaptureReplayEnvironment = {
    operatingSystem: 'macOS',
    operatingSystemVersion: options.operatingSystemVersion,
    architecture: 'arm64',
    graphicsApi: 'Metal',
    gpuName: options.gpuName,
    gpuDriverVersion: options.gpuDriverVersion,
    toolName: 'Xcode Metal Frame Debugger',
    toolVersion: options.xcodeVersion,
    toolBuildVersion: options.xcodeBuildVersion,
    metalCompilerVersion: options.metalCompilerVersion,
    unityVersion: options.unityVersion,
    unityBinaryVersion: options.unityBinaryVersion,
    adapterVersion: options.adapterVersion,
  };
  const traceVerification: GpuCaptureTraceVerification = options.sanitizedFixture
    ? { status: 'sanitized-fixture' }
    : await verifyLocalGpuTrace(
        resolve(options.trace!),
        (
          evidence !== null
          && typeof evidence === 'object'
          && 'draw' in evidence
          && evidence.draw !== null
          && typeof evidence.draw === 'object'
          && 'label' in evidence.draw
          && typeof evidence.draw.label === 'string'
        ) ? evidence.draw.label : undefined,
      );
  const result = correlateGpuCaptureEvidence({
    evidence,
    projectId: options.projectId,
    sourceUri: options.sourceUri,
    sourceAssetGuid: options.assetGuid,
    sourceText,
    replayEnvironment,
    traceVerification,
  });
  const machine = `${JSON.stringify(result, null, 2)}\n`;
  const report = `${human(result)}\n`;
  if (options.json === '-') {
    process.stdout.write(machine);
    process.stderr.write(report);
  } else {
    const reportPath = resolve(options.json);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, machine, 'utf8');
    process.stdout.write(report);
    process.stdout.write(`Machine report: ${options.json.replace(/\\/g, '/')}\n`);
  }
  process.exitCode = result.status === 'current'
    ? 0
    : result.status === 'unavailable'
      ? 2
      : 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `GPU capture correlation crashed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 3;
});
