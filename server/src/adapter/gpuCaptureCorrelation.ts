import { createHash } from 'node:crypto';
import type {
  GpuCaptureCorrelationResult,
  GpuCaptureEvidence,
  GpuCaptureReplayEnvironment,
  GpuCaptureTraceVerification,
  Range,
  ShaderStage,
} from '@unity-shader-nav/shared';
import { GPU_CAPTURE_CORRELATION_CAPABILITY } from '@unity-shader-nav/shared';

const HASH = /^[a-f0-9]{64}$/;
const STAGES = new Set<ShaderStage>([
  'vertex',
  'fragment',
  'geometry',
  'hull',
  'domain',
  'surface',
  'kernel',
  'raytracing',
]);
const MAPPING_FAILURES = new Set([
  'generated-source-has-no-line-map',
  'entry-point-not-found',
  'ambiguous-source-range',
  'capture-tool-omitted-shader-text',
  'unsupported-trace-version',
]);

export interface GpuCaptureEvidenceSource {
  getGpuCaptureEvidence(captureId: string): Promise<unknown>;
}

export interface GpuCaptureCorrelationRequest {
  readonly captureId: string;
  readonly projectId: string;
  readonly sourceUri: string;
  readonly sourceAssetGuid: string;
  readonly sourceText: string;
  readonly replayEnvironment: GpuCaptureReplayEnvironment;
  readonly traceVerification: GpuCaptureTraceVerification;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function position(value: unknown): boolean {
  return record(value)
    && nonNegativeInteger(value.line)
    && nonNegativeInteger(value.character);
}

function range(value: unknown): value is Range {
  return record(value) && position(value.start) && position(value.end);
}

function stringArray(value: unknown, max: number): value is string[] {
  return Array.isArray(value)
    && value.length <= max
    && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

/**
 * Validate the checked-in bounded contract, not the raw `.gputrace` format.
 * The trace stays tool-owned and local; only sanitized correlation facts cross
 * this Adapter seam.
 */
export function validateGpuCaptureEvidence(value: unknown): string | null {
  if (!record(value) || value.schemaVersion !== 1) {
    return 'schemaVersion must be 1';
  }
  const provenance = value.provenance;
  if (
    !record(provenance)
    || provenance.capability !== GPU_CAPTURE_CORRELATION_CAPABILITY
    || !nonEmptyString(provenance.adapterVersion)
    || !nonEmptyString(provenance.unityVersion)
    || !nonEmptyString(provenance.unityBinaryVersion)
    || !nonEmptyString(provenance.projectId)
    || !nonEmptyString(provenance.instanceId)
    || typeof provenance.collectedAt !== 'number'
    || !Number.isFinite(provenance.collectedAt)
    || provenance.collectedAt <= 0
  ) return 'provenance is invalid';
  if (
    !record(provenance.platform)
    || provenance.platform.operatingSystem !== 'macOS'
    || !nonEmptyString(provenance.platform.operatingSystemVersion)
    || provenance.platform.architecture !== 'arm64'
    || provenance.graphicsApi !== 'Metal'
  ) return 'platform provenance is invalid';
  if (
    !record(provenance.gpu)
    || !nonEmptyString(provenance.gpu.name)
    || !nonEmptyString(provenance.gpu.driverVersion)
    || (
      provenance.gpu.registryId !== undefined
      && !nonEmptyString(provenance.gpu.registryId)
    )
  ) return 'GPU provenance is invalid';
  if (
    !record(provenance.tool)
    || provenance.tool.name !== 'Xcode Metal Frame Debugger'
    || !nonEmptyString(provenance.tool.version)
    || !nonEmptyString(provenance.tool.buildVersion)
    || !nonEmptyString(provenance.tool.metalCompilerVersion)
    || provenance.tool.traceFormat !== 'gputrace'
  ) return 'capture-tool provenance is invalid';
  if (
    !record(provenance.sourceRevision)
    || !nonEmptyString(provenance.sourceRevision.uri)
    || !nonEmptyString(provenance.sourceRevision.assetGuid)
    || !HASH.test(String(provenance.sourceRevision.contentHash))
  ) return 'source revision is invalid';

  const draw = value.draw;
  if (
    !record(draw)
    || !nonEmptyString(draw.captureId)
    || !nonNegativeInteger(draw.frameIndex)
    || !nonNegativeInteger(draw.drawIndex)
    || !nonEmptyString(draw.label)
    || !record(draw.trace)
    || draw.trace.storage !== 'local-ephemeral'
    || !nonEmptyString(draw.trace.fileName)
    || !String(draw.trace.fileName).endsWith('.gputrace')
    || /[/\\]/.test(String(draw.trace.fileName))
    || !HASH.test(String(draw.trace.sha256))
    || !positiveInteger(draw.trace.byteLength)
  ) return 'captured draw identity is invalid';

  const context = value.context;
  if (
    !record(context)
    || !nonEmptyString(context.id)
    || !nonEmptyString(context.shaderName)
    || !nonNegativeInteger(context.subShaderIndex)
    || !nonNegativeInteger(context.passIndex)
    || (context.passName !== undefined && !nonEmptyString(context.passName))
    || !nonEmptyString(context.stage)
    || !STAGES.has(context.stage as ShaderStage)
    || !nonEmptyString(context.entryPoint)
    || !record(context.keywords)
    || !stringArray(context.keywords.enabled, 256)
    || typeof context.keywords.incomplete !== 'boolean'
  ) return 'captured Shader Context is invalid';

  const mapping = value.mapping;
  if (!record(mapping)) return 'source mapping is invalid';
  if (mapping.status === 'unmapped') {
    if (
      !nonEmptyString(mapping.reason)
      || !MAPPING_FAILURES.has(mapping.reason)
      || !nonEmptyString(mapping.detail)
    ) return 'unmapped source evidence is invalid';
  } else if (
    mapping.status !== 'mapped'
    || mapping.method !== 'adapter-exact-source-range'
    || !nonEmptyString(mapping.uri)
    || !range(mapping.range)
    || !nonEmptyString(mapping.expectedText)
    || !nonEmptyString(mapping.sourceEntryPoint)
    || mapping.expectedText !== context.entryPoint
    || mapping.sourceEntryPoint !== context.entryPoint
  ) {
    return 'mapped source evidence is invalid';
  }
  return null;
}

function sourceHash(sourceText: string): string {
  return createHash('sha256').update(sourceText, 'utf8').digest('hex');
}

function offsetAt(source: string, line: number, character: number): number | null {
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) return null;
    offset = newline + 1;
    currentLine++;
  }
  const newline = source.indexOf('\n', offset);
  const lineEnd = newline < 0 ? source.length : newline;
  const contentEnd = lineEnd > offset && source[lineEnd - 1] === '\r'
    ? lineEnd - 1
    : lineEnd;
  return character <= contentEnd - offset ? offset + character : null;
}

function mappedText(source: string, mappedRange: Range): string | null {
  const start = offsetAt(
    source,
    mappedRange.start.line,
    mappedRange.start.character,
  );
  const end = offsetAt(
    source,
    mappedRange.end.line,
    mappedRange.end.character,
  );
  if (start === null || end === null || end < start) return null;
  return source.slice(start, end);
}

export function correlateGpuCaptureEvidence(input: {
  readonly evidence: unknown;
  readonly projectId: string;
  readonly sourceUri: string;
  readonly sourceAssetGuid: string;
  readonly sourceText: string;
  readonly replayEnvironment: GpuCaptureReplayEnvironment;
  readonly traceVerification: GpuCaptureTraceVerification;
}): GpuCaptureCorrelationResult {
  const invalid = validateGpuCaptureEvidence(input.evidence);
  if (invalid) {
    return { status: 'unavailable', reason: 'invalid-evidence', detail: invalid };
  }
  const evidence = input.evidence as GpuCaptureEvidence;
  if (evidence.provenance.projectId !== input.projectId) {
    return {
      status: 'unavailable',
      reason: 'project-mismatch',
      detail: `capture project '${evidence.provenance.projectId}' does not match current project`,
    };
  }
  const environment = input.replayEnvironment;
  if (
    evidence.provenance.platform.operatingSystem !== environment.operatingSystem
    || evidence.provenance.platform.operatingSystemVersion
      !== environment.operatingSystemVersion
    || evidence.provenance.platform.architecture !== environment.architecture
    || evidence.provenance.graphicsApi !== environment.graphicsApi
    || evidence.provenance.gpu.name !== environment.gpuName
    || evidence.provenance.gpu.driverVersion !== environment.gpuDriverVersion
    || evidence.provenance.tool.name !== environment.toolName
    || evidence.provenance.tool.version !== environment.toolVersion
    || evidence.provenance.tool.buildVersion !== environment.toolBuildVersion
    || evidence.provenance.tool.metalCompilerVersion
      !== environment.metalCompilerVersion
    || evidence.provenance.unityVersion !== environment.unityVersion
    || evidence.provenance.unityBinaryVersion
      !== environment.unityBinaryVersion
    || evidence.provenance.adapterVersion !== environment.adapterVersion
  ) {
    return {
      status: 'unavailable',
      reason: 'replay-environment-mismatch',
      detail:
        'capture requires the exact macOS, GPU, Metal, Xcode, Unity, and Adapter environment',
    };
  }
  if (evidence.provenance.sourceRevision.uri !== input.sourceUri) {
    return { status: 'stale', reason: 'source-uri-mismatch', evidence };
  }
  if (evidence.provenance.sourceRevision.assetGuid !== input.sourceAssetGuid) {
    return { status: 'stale', reason: 'asset-guid-mismatch', evidence };
  }
  if (evidence.provenance.sourceRevision.contentHash !== sourceHash(input.sourceText)) {
    return { status: 'stale', reason: 'source-hash-mismatch', evidence };
  }
  if (input.traceVerification.status === 'verified-local-trace') {
    const trace = evidence.draw.trace;
    if (
      input.traceVerification.fileName !== trace.fileName
      || input.traceVerification.sha256 !== trace.sha256
      || input.traceVerification.byteLength !== trace.byteLength
    ) {
      return {
        status: 'unavailable',
        reason: 'trace-identity-mismatch',
        detail: 'local trace hash, size, or filename does not match captured evidence',
      };
    }
    if (!input.traceVerification.labels.includes(evidence.draw.label)) {
      return {
        status: 'unavailable',
        reason: 'trace-label-missing',
        detail: `local trace does not contain draw label '${evidence.draw.label}'`,
      };
    }
  }
  if (evidence.mapping.status === 'unmapped') {
    return {
      status: 'unmapped',
      reason: evidence.mapping.reason,
      detail: evidence.mapping.detail,
      evidence,
    };
  }
  if (evidence.mapping.uri !== input.sourceUri) {
    return { status: 'stale', reason: 'source-uri-mismatch', evidence };
  }
  const text = mappedText(input.sourceText, evidence.mapping.range);
  if (text === null) {
    return {
      status: 'unmapped',
      reason: 'mapped-range-invalid',
      detail: 'mapped source range is outside the exact captured source',
      evidence,
    };
  }
  if (text !== evidence.mapping.expectedText) {
    return {
      status: 'unmapped',
      reason: 'mapped-text-mismatch',
      detail: `mapped text '${text}' does not equal '${evidence.mapping.expectedText}'`,
      evidence,
    };
  }
  return {
    status: 'current',
    traceStatus: input.traceVerification.status,
    evidence,
    uri: evidence.mapping.uri,
    range: evidence.mapping.range,
    context: evidence.context,
  };
}

/**
 * One-source prototype seam. Production multi-tool dispatch is deliberately
 * absent until a second capture Adapter satisfies ADR-0012's entry criteria.
 */
export class GpuCaptureCorrelationAdapter {
  constructor(private readonly source: GpuCaptureEvidenceSource) {}

  async correlate(
    request: GpuCaptureCorrelationRequest,
  ): Promise<GpuCaptureCorrelationResult> {
    let evidence: unknown;
    try {
      evidence = await this.source.getGpuCaptureEvidence(request.captureId);
    } catch (error) {
      return {
        status: 'unavailable',
        reason: 'invalid-evidence',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (
      record(evidence)
      && record(evidence.draw)
      && evidence.draw.captureId !== request.captureId
    ) {
      return {
        status: 'unavailable',
        reason: 'invalid-evidence',
        detail: 'capture identity does not match the requested capture',
      };
    }
    return correlateGpuCaptureEvidence({
      evidence,
      projectId: request.projectId,
      sourceUri: request.sourceUri,
      sourceAssetGuid: request.sourceAssetGuid,
      sourceText: request.sourceText,
      replayEnvironment: request.replayEnvironment,
      traceVerification: request.traceVerification,
    });
  }
}
