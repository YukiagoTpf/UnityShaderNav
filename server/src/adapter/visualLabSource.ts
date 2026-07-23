import { createHash } from 'node:crypto';
import {
  MAX_VISUAL_LAB_IMAGE_DIMENSION,
  MAX_VISUAL_LAB_PNG_BYTES,
  VISUAL_LAB_ADAPTER_FEATURE,
  type VisualLabCaptureFailureReason,
  type VisualLabDescribeTargetRequest,
  type VisualLabDescribeTargetResponse,
  type VisualLabFrameEvidence,
  type IncludePointContext,
  type SelectedMaterialContext,
  type VisualLabRenderRequest,
  type VisualLabRenderTarget,
  type VisualLabSelectionIdentity,
  type VisualLabStaleReason,
  type VisualLabUnavailableReason,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';

/** Transport-neutral Adapter boundary for target resolution and one-frame rendering. */
export interface VisualLabSource {
  describePreviewTarget(
    request: VisualLabDescribeTargetRequest,
    cancellation?: AbortSignal,
  ): Promise<unknown>;
  renderPreview(
    request: VisualLabRenderRequest,
    cancellation?: AbortSignal,
  ): Promise<unknown>;
  /**
   * Adapter-side profile/input changes and connection teardown invalidate all
   * retained frames immediately, independently from the next capture request.
   */
  onDidInvalidate?(
    listener: (reason: VisualLabSourceInvalidationReason) => void,
  ): { dispose(): void };
}

export type VisualLabSourceInvalidationReason = Extract<
  VisualLabStaleReason,
  | 'pipeline-changed'
  | 'profile-changed'
  | 'color-space-changed'
  | 'render-input-changed'
  | 'adapter-instance-changed'
  | 'adapter-disconnected'
  | 'domain-reloaded'
>;

export type VisualLabSelectionResult =
  | {
      readonly availability: 'available';
      readonly selection: VisualLabSelectionIdentity;
    }
  | {
      readonly availability: 'unavailable';
      readonly reason: VisualLabUnavailableReason;
    };

/** Read-only view of the current Adapter-backed Material Context identity. */
export interface VisualLabSelectionProvider {
  selectedVisualLabMaterial(
    documentUri: string,
  ): Promise<VisualLabSelectionResult>;
}

export type VisualLabEvidenceValidationFailure = Extract<
  VisualLabCaptureFailureReason,
  'invalid-evidence' | 'evidence-limit-exceeded' | 'identity-mismatch'
>;

/**
 * Build the bounded describe request from two existing authoritative sources:
 * Adapter Material Context, its LSP publication, and the explicitly selected
 * source Include Context.
 */
export function createVisualLabSelectionIdentity(
  context: SelectedMaterialContext,
  requested: IncludePointContext,
  contextRevision: string,
): VisualLabSelectionIdentity | undefined {
  if (
    !nonEmptyString(contextRevision)
    || uriKey(context.shader.revision.uri) !== uriKey(requested.shaderUri)
    || (requested.passIndex === undefined && requested.passName === undefined)
    || (
      context.selectedProgram !== undefined
      && (
        context.selectedProgram.subShaderIndex !== requested.subShaderIndex
        || (
          context.selectedProgram.passIndex !== undefined
          && context.selectedProgram.passIndex !== requested.passIndex
        )
        || (
          context.selectedProgram.passName !== undefined
          && context.selectedProgram.passName !== requested.passName
        )
      )
    )
  ) return undefined;

  const selection: VisualLabSelectionIdentity = {
    selectionId: context.selectionId,
    contextRevision,
    material: cloneContextAsset(context.material),
    source: cloneContextAsset(context.shader),
    ...(context.selectedProgram
      ? { selectedProgram: { ...context.selectedProgram } }
      : {}),
    requestedContext: {
      contextId: requested.id,
      shaderUri: requested.shaderUri,
      subShaderIndex: requested.subShaderIndex,
      ...(requested.passIndex !== undefined
        ? { passIndex: requested.passIndex }
        : {}),
      ...(requested.passName ? { passName: requested.passName } : {}),
      stage: requested.stage,
      entryPoint: requested.entryPoint,
    },
    materialKeywords: context.keywords.material
      .map((keyword) => ({ ...keyword }))
      .sort((left, right) => ordinalCompare(
        `${left.scope}\u0000${left.name}`,
        `${right.scope}\u0000${right.name}`,
      )),
    adapter: {
      projectId: context.provenance.projectId,
      instanceId: context.provenance.instanceId,
      adapterVersion: context.provenance.adapterVersion,
      unityVersion: context.provenance.unityVersion,
    },
  };
  return validVisualLabSelectionIdentity(selection) ? selection : undefined;
}

const SHA256 = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);
const SHADER_STAGES = new Set([
  'vertex',
  'fragment',
  'geometry',
  'hull',
  'domain',
  'surface',
  'kernel',
  'raytracing',
]);

/** Runtime validation before a selected Material identity crosses to the Adapter. */
export function validVisualLabSelectionIdentity(
  value: unknown,
): value is VisualLabSelectionIdentity {
  if (
    !record(value)
    || !nonEmptyString(value.selectionId)
    || !nonEmptyString(value.contextRevision)
    || !validContextAsset(value.material)
    || !validContextAsset(value.source)
    || !validAdapterIdentity(value.adapter)
    || !Array.isArray(value.materialKeywords)
    || !validMaterialKeywords(value.materialKeywords)
    || (
      value.selectedProgram !== undefined
      && !validSelectedProgram(value.selectedProgram)
    )
    || !validRequestedContext(value.requestedContext)
    || uriKey(value.requestedContext.shaderUri)
      !== uriKey(value.source.revision.uri)
    || (
      value.selectedProgram !== undefined
      && !requestedContextMatchesProgram(
        value.requestedContext,
        value.selectedProgram,
      )
    )
  ) return false;
  return true;
}

/** Runtime validation for the complete Adapter-owned final draw identity. */
export function validVisualLabRenderTarget(
  value: unknown,
): value is VisualLabRenderTarget {
  if (
    !record(value)
    || !nonEmptyString(value.selectionId)
    || !nonEmptyString(value.contextRevision)
    || !validContextAsset(value.material)
    || !validContextAsset(value.source)
    || !validShaderContext(value.shaderContext)
    || !validPipeline(value.pipeline)
    || !validProfile(value.profile)
    || (value.colorSpace !== 'linear' && value.colorSpace !== 'gamma')
    || !validAdapterIdentity(value.adapter)
    || !nonEmptyString(value.renderInputId)
  ) return false;
  return true;
}

/**
 * Accept a target description only when the Adapter repeats the exact selected
 * Material, Shader, snapshot, and connection identities supplied by the server.
 */
export function validateVisualLabTargetDescription(
  value: unknown,
  request: VisualLabDescribeTargetRequest,
): VisualLabEvidenceValidationFailure | undefined {
  if (
    !record(value)
    || value.capability !== VISUAL_LAB_ADAPTER_FEATURE
    || !validVisualLabRenderTarget(value.target)
  ) return 'invalid-evidence';
  if (
    !validVisualLabSelectionIdentity(request.selection)
    || !targetMatchesSelection(value.target, request.selection)
  ) return 'identity-mismatch';
  return undefined;
}

/** Parse and defensively clone one validated target description. */
export function cloneVisualLabTargetDescription(
  value: unknown,
): VisualLabDescribeTargetResponse {
  const description = value as VisualLabDescribeTargetResponse;
  return {
    capability: VISUAL_LAB_ADAPTER_FEATURE,
    target: cloneVisualLabRenderTarget(description.target),
  };
}

/**
 * Validate identity, provenance, PNG bounds, and exact diagnostic bytes. The
 * NaN/Inf counts are checked against the R8 mask, never inferred from image diff.
 */
export function validateVisualLabFrameEvidence(
  value: unknown,
  request: VisualLabRenderRequest,
  now: number,
): VisualLabEvidenceValidationFailure | undefined {
  if (!record(value) || value.capability !== VISUAL_LAB_ADAPTER_FEATURE) {
    return 'invalid-evidence';
  }
  if (
    value.slot !== request.slot
    || value.requestGeneration !== request.requestGeneration
  ) return 'identity-mismatch';
  if (!validVisualLabRenderTarget(value.target)) return 'invalid-evidence';
  if (
    !validVisualLabRenderTarget(request.target)
    || visualLabRenderTargetKey(value.target)
      !== visualLabRenderTargetKey(request.target)
  ) return 'identity-mismatch';
  if (
    typeof value.capturedAt !== 'number'
    || !Number.isSafeInteger(value.capturedAt)
    || value.capturedAt <= 0
    || value.capturedAt > now
  ) return 'invalid-evidence';

  const imageFailure = validatePngImage(value.image, request.target);
  if (imageFailure) return imageFailure;
  if (!record(value.diagnostic)) return 'invalid-evidence';
  return validateNanInfMask(
    value.diagnostic.nanInfMask,
    request.target,
  );
}

export function cloneVisualLabRenderTarget(
  target: VisualLabRenderTarget,
): VisualLabRenderTarget {
  return {
    selectionId: target.selectionId,
    contextRevision: target.contextRevision,
    material: cloneContextAsset(target.material),
    source: cloneContextAsset(target.source),
    shaderContext: {
      ...target.shaderContext,
      keywords: {
        material: [...target.shaderContext.keywords.material],
        global: [...target.shaderContext.keywords.global],
        engineAdded: [...target.shaderContext.keywords.engineAdded],
      },
    },
    pipeline: { ...target.pipeline },
    profile: {
      ...target.profile,
      renderTarget: { ...target.profile.renderTarget },
    },
    colorSpace: target.colorSpace,
    adapter: { ...target.adapter },
    renderInputId: target.renderInputId,
  };
}

export function cloneVisualLabSelectionIdentity(
  selection: VisualLabSelectionIdentity,
): VisualLabSelectionIdentity {
  return {
    selectionId: selection.selectionId,
    contextRevision: selection.contextRevision,
    material: cloneContextAsset(selection.material),
    source: cloneContextAsset(selection.source),
    ...(selection.selectedProgram
      ? { selectedProgram: { ...selection.selectedProgram } }
      : {}),
    requestedContext: { ...selection.requestedContext },
    materialKeywords: selection.materialKeywords.map((keyword) => ({
      ...keyword,
    })),
    adapter: { ...selection.adapter },
  };
}

export function cloneVisualLabFrameEvidence(
  frame: VisualLabFrameEvidence,
): VisualLabFrameEvidence {
  return {
    capability: VISUAL_LAB_ADAPTER_FEATURE,
    slot: frame.slot,
    requestGeneration: frame.requestGeneration,
    target: cloneVisualLabRenderTarget(frame.target),
    capturedAt: frame.capturedAt,
    image: { ...frame.image },
    diagnostic: {
      nanInfMask: { ...frame.diagnostic.nanInfMask },
    },
  };
}

/** Canonical key used only after runtime validation has enforced sorted sets. */
export function visualLabRenderTargetKey(target: VisualLabRenderTarget): string {
  return JSON.stringify([
    target.selectionId,
    target.contextRevision,
    contextAssetKey(target.material),
    contextAssetKey(target.source),
    [
      target.shaderContext.contextId,
      target.shaderContext.shaderName,
      target.shaderContext.subShaderIndex,
      target.shaderContext.passIndex,
      target.shaderContext.passName ?? null,
      target.shaderContext.stage,
      target.shaderContext.entryPoint,
      [...target.shaderContext.keywords.material],
      [...target.shaderContext.keywords.global],
      [...target.shaderContext.keywords.engineAdded],
    ],
    [
      target.pipeline.id,
      target.pipeline.kind,
      target.pipeline.name,
      target.pipeline.assetGuid ?? null,
      target.pipeline.contentHash ?? null,
    ],
    [
      target.profile.id,
      target.profile.buildTarget,
      target.profile.graphicsApi,
      target.profile.qualityLevel,
      target.profile.renderTarget.width,
      target.profile.renderTarget.height,
      target.profile.renderTarget.format,
    ],
    target.colorSpace,
    [
      target.adapter.projectId,
      target.adapter.instanceId,
      target.adapter.adapterVersion,
      target.adapter.unityVersion,
    ],
    target.renderInputId,
  ]);
}

export function visualLabSelectionKey(
  selection: VisualLabSelectionIdentity,
): string {
  return JSON.stringify([
    selection.selectionId,
    selection.contextRevision,
    contextAssetKey(selection.material),
    contextAssetKey(selection.source),
    selection.selectedProgram
      ? [
          selection.selectedProgram.subShaderIndex,
          selection.selectedProgram.passIndex ?? null,
          selection.selectedProgram.passName ?? null,
        ]
      : null,
    [
      selection.requestedContext.contextId,
      uriKey(selection.requestedContext.shaderUri),
      selection.requestedContext.subShaderIndex,
      selection.requestedContext.passIndex ?? null,
      selection.requestedContext.passName ?? null,
      selection.requestedContext.stage,
      selection.requestedContext.entryPoint,
    ],
    selection.materialKeywords.map((keyword) => [
      keyword.scope,
      keyword.name,
      keyword.enabled,
    ]),
    [
      selection.adapter.projectId,
      selection.adapter.instanceId,
      selection.adapter.adapterVersion,
      selection.adapter.unityVersion,
    ],
  ]);
}

function targetMatchesSelection(
  target: VisualLabRenderTarget,
  selection: VisualLabSelectionIdentity,
): boolean {
  if (
    target.selectionId !== selection.selectionId
    || target.contextRevision !== selection.contextRevision
    || contextAssetKey(target.material) !== contextAssetKey(selection.material)
    || contextAssetKey(target.source) !== contextAssetKey(selection.source)
    || !sameAdapter(target.adapter, selection.adapter)
  ) return false;

  if (
    target.shaderContext.contextId !== selection.requestedContext.contextId
    || target.shaderContext.subShaderIndex
      !== selection.requestedContext.subShaderIndex
    || (
      selection.requestedContext.passIndex !== undefined
      && target.shaderContext.passIndex
        !== selection.requestedContext.passIndex
    )
    || (
      selection.requestedContext.passName !== undefined
      && target.shaderContext.passName
        !== selection.requestedContext.passName
    )
    || target.shaderContext.stage !== selection.requestedContext.stage
    || target.shaderContext.entryPoint
      !== selection.requestedContext.entryPoint
    || (
      selection.selectedProgram !== undefined
      && (
        target.shaderContext.subShaderIndex
          !== selection.selectedProgram.subShaderIndex
        || (
          selection.selectedProgram.passIndex !== undefined
          && target.shaderContext.passIndex
            !== selection.selectedProgram.passIndex
        )
        || (
          selection.selectedProgram.passName !== undefined
          && target.shaderContext.passName
            !== selection.selectedProgram.passName
        )
      )
    )
  ) return false;

  const enabledMaterialKeywords = [...new Set(
    selection.materialKeywords
      .filter((keyword) => keyword.enabled)
      .map((keyword) => keyword.name),
  )].sort(ordinalCompare);
  return sameStrings(
    target.shaderContext.keywords.material,
    enabledMaterialKeywords,
  );
}

function validatePngImage(
  value: unknown,
  target: VisualLabRenderTarget,
): VisualLabEvidenceValidationFailure | undefined {
  if (!record(value)) return 'invalid-evidence';
  if (
    value.mediaType !== 'image/png'
    || value.encoding !== 'base64'
    || value.width !== target.profile.renderTarget.width
    || value.height !== target.profile.renderTarget.height
    || !nonNegativeSafeInteger(value.byteLength)
    || !SHA256.test(string(value.sha256))
  ) return 'invalid-evidence';
  if ((value.byteLength as number) > MAX_VISUAL_LAB_PNG_BYTES) {
    return 'evidence-limit-exceeded';
  }
  const bytes = decodeCanonicalBase64(value.data, value.byteLength as number);
  if (!bytes || !validPng(bytes, value.width as number, value.height as number)) {
    return 'invalid-evidence';
  }
  return sha256(bytes) === value.sha256 ? undefined : 'invalid-evidence';
}

function validateNanInfMask(
  value: unknown,
  target: VisualLabRenderTarget,
): VisualLabEvidenceValidationFailure | undefined {
  if (!record(value)) return 'invalid-evidence';
  const { width, height } = target.profile.renderTarget;
  const expectedLength = width * height;
  if (
    value.format !== 'r8'
    || value.origin !== 'top-left'
    || value.layout !== 'row-major'
    || value.encoding !== 'base64'
    || value.width !== width
    || value.height !== height
    || value.byteLength !== expectedLength
    || !nonNegativeSafeInteger(value.nanPixelCount)
    || !nonNegativeSafeInteger(value.infinitePixelCount)
    || !nonNegativeSafeInteger(value.maskedPixelCount)
    || (value.nanPixelCount as number) + (value.infinitePixelCount as number)
      !== value.maskedPixelCount
    || (value.maskedPixelCount as number) > expectedLength
  ) return 'invalid-evidence';

  const bytes = decodeCanonicalBase64(value.data, expectedLength);
  if (!bytes) return 'invalid-evidence';
  let maskedPixelCount = 0;
  for (const byte of bytes) {
    if (byte === 255) maskedPixelCount++;
    else if (byte !== 0) return 'invalid-evidence';
  }
  return maskedPixelCount === value.maskedPixelCount
    ? undefined
    : 'invalid-evidence';
}

function validPng(bytes: Buffer, width: number, height: number): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }
  let offset = 8;
  let chunkIndex = 0;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) return false;
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (chunkIndex === 0 && (
      type !== 'IHDR'
      || length !== 13
      || bytes.readUInt32BE(offset + 8) !== width
      || bytes.readUInt32BE(offset + 12) !== height
    )) return false;
    if (type === 'IDAT') sawImageData = true;
    if (type === 'IEND') {
      return length === 0
        && sawImageData
        && chunkEnd === bytes.length
        && bytes.subarray(bytes.length - PNG_IEND.length).equals(PNG_IEND);
    }
    offset = chunkEnd;
    chunkIndex++;
  }
  return false;
}

function validContextAsset(
  value: unknown,
): value is VisualLabRenderTarget['material'] {
  return record(value)
    && nonEmptyString(value.name)
    && nonEmptyString(value.path)
    && (
      value.path.startsWith('Assets/')
      || value.path.startsWith('Packages/')
    )
    && validSourceRevision(value.revision);
}

function validSourceRevision(value: unknown): boolean {
  return record(value)
    && nonEmptyString(value.uri)
    && nonEmptyString(value.assetGuid)
    && SHA256.test(string(value.contentHash));
}

function validShaderContext(value: unknown): boolean {
  return record(value)
    && nonEmptyString(value.contextId)
    && nonEmptyString(value.shaderName)
    && nonNegativeSafeInteger(value.subShaderIndex)
    && nonNegativeSafeInteger(value.passIndex)
    && (value.passName === undefined || nonEmptyString(value.passName))
    && SHADER_STAGES.has(string(value.stage))
    && nonEmptyString(value.entryPoint)
    && record(value.keywords)
    && validSortedStringSet(value.keywords.material)
    && validSortedStringSet(value.keywords.global)
    && validSortedStringSet(value.keywords.engineAdded);
}

function validPipeline(value: unknown): boolean {
  if (
    !record(value)
    || !nonEmptyString(value.id)
    || (value.kind !== 'built-in' && value.kind !== 'scriptable')
    || !nonEmptyString(value.name)
  ) return false;
  const hasGuid = nonEmptyString(value.assetGuid);
  const hasHash = SHA256.test(string(value.contentHash));
  if (hasGuid !== hasHash) return false;
  return value.kind === 'built-in' || (hasGuid && hasHash);
}

function validProfile(value: unknown): boolean {
  if (
    !record(value)
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.buildTarget)
    || !nonEmptyString(value.graphicsApi)
    || !nonNegativeSafeInteger(value.qualityLevel)
    || !record(value.renderTarget)
    || !positiveSafeInteger(value.renderTarget.width)
    || !positiveSafeInteger(value.renderTarget.height)
    || !nonEmptyString(value.renderTarget.format)
  ) return false;
  return (value.renderTarget.width as number) <= MAX_VISUAL_LAB_IMAGE_DIMENSION
    && (value.renderTarget.height as number) <= MAX_VISUAL_LAB_IMAGE_DIMENSION;
}

function validAdapterIdentity(value: unknown): boolean {
  return record(value)
    && nonEmptyString(value.projectId)
    && nonEmptyString(value.instanceId)
    && nonEmptyString(value.adapterVersion)
    && nonEmptyString(value.unityVersion);
}

function validSelectedProgram(
  value: unknown,
): value is NonNullable<VisualLabSelectionIdentity['selectedProgram']> {
  return record(value)
    && nonNegativeSafeInteger(value.subShaderIndex)
    && (
      value.passIndex === undefined
      || nonNegativeSafeInteger(value.passIndex)
    )
    && (value.passName === undefined || nonEmptyString(value.passName));
}

function validRequestedContext(
  value: unknown,
): value is VisualLabSelectionIdentity['requestedContext'] {
  return record(value)
    && nonEmptyString(value.contextId)
    && nonEmptyString(value.shaderUri)
    && nonNegativeSafeInteger(value.subShaderIndex)
    && (
      value.passIndex === undefined
      || nonNegativeSafeInteger(value.passIndex)
    )
    && (value.passName === undefined || nonEmptyString(value.passName))
    && (value.passIndex !== undefined || value.passName !== undefined)
    && SHADER_STAGES.has(string(value.stage))
    && nonEmptyString(value.entryPoint);
}

function requestedContextMatchesProgram(
  context: VisualLabSelectionIdentity['requestedContext'],
  program: NonNullable<VisualLabSelectionIdentity['selectedProgram']>,
): boolean {
  return context.subShaderIndex === program.subShaderIndex
    && (
      program.passIndex === undefined
      || context.passIndex === program.passIndex
    )
    && (
      program.passName === undefined
      || context.passName === program.passName
    );
}

function validMaterialKeywords(value: readonly unknown[]): boolean {
  let previous: string | undefined;
  for (const keyword of value) {
    if (
      !record(keyword)
      || !nonEmptyString(keyword.name)
      || typeof keyword.enabled !== 'boolean'
      || (keyword.scope !== 'local' && keyword.scope !== 'legacy')
    ) return false;
    const key = `${keyword.scope}\u0000${keyword.name}`;
    if (previous !== undefined && previous >= key) return false;
    previous = key;
  }
  return true;
}

function validSortedStringSet(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  let previous: string | undefined;
  for (const entry of value) {
    if (!nonEmptyString(entry)) return false;
    if (previous !== undefined && previous >= entry) return false;
    previous = entry;
  }
  return true;
}

function cloneContextAsset(
  asset: VisualLabRenderTarget['material'],
): VisualLabRenderTarget['material'] {
  return {
    name: asset.name,
    path: asset.path,
    revision: { ...asset.revision },
  };
}

function contextAssetKey(asset: VisualLabRenderTarget['material']): string {
  return JSON.stringify([
    asset.name,
    asset.path,
    uriKey(asset.revision.uri),
    asset.revision.assetGuid,
    asset.revision.contentHash,
  ]);
}

function sameAdapter(
  left: VisualLabRenderTarget['adapter'],
  right: VisualLabSelectionIdentity['adapter'],
): boolean {
  return left.projectId === right.projectId
    && left.instanceId === right.instanceId
    && left.adapterVersion === right.adapterVersion
    && left.unityVersion === right.unityVersion;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function decodeCanonicalBase64(
  value: unknown,
  expectedLength: number,
): Buffer | undefined {
  if (
    typeof value !== 'string'
    || value.length !== Math.ceil(expectedLength / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === expectedLength
    && bytes.toString('base64') === value
    ? bytes
    : undefined;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0;
}
