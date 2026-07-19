import type { VariantBuildEvidence } from '@unity-shader-nav/shared';

export const MAX_VARIANT_BUILD_CONTEXTS = 2_048;
export const MAX_VARIANT_KEYWORD_SETS_PER_CONTEXT = 256;
export const MAX_VARIANT_KEYWORDS_PER_SET = 256;
export const MAX_TOTAL_VARIANT_KEYWORD_SETS = 8_192;

/**
 * Transport-neutral Adapter boundary for the latest bounded build snapshot of
 * one Shader. A null snapshot means that no build evidence was collected.
 */
export interface VariantBuildEvidenceSource {
  getVariantBuildEvidence(documentUri: string): Promise<VariantBuildEvidence | null>;
}

export type VariantBuildEvidenceValidationFailure =
  | 'evidence-limit-exceeded'
  | 'invalid-evidence';

const BUILD_STATUSES = new Set(['completed', 'incomplete', 'failed']);
const FAILURE_PHASES = new Set(['compilation', 'stripping', 'build']);
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
const UNAVAILABLE_REASONS = new Set([
  'not-collected',
  'build-failed',
  'unsupported',
]);
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** Runtime validation at the Adapter trust boundary. */
export function validateVariantBuildEvidence(
  value: unknown,
): VariantBuildEvidenceValidationFailure | undefined {
  if (!record(value)) return 'invalid-evidence';
  if (!BUILD_STATUSES.has(string(value.status))) return 'invalid-evidence';
  if (!validFailure(value.status, value.failure)) return 'invalid-evidence';
  if (!validProvenance(value.provenance)) return 'invalid-evidence';
  if (!Array.isArray(value.contexts)) return 'invalid-evidence';
  if (value.contexts.length > MAX_VARIANT_BUILD_CONTEXTS) {
    return 'evidence-limit-exceeded';
  }

  let keywordSetCount = 0;
  const contextKeys = new Set<string>();
  for (const context of value.contexts) {
    if (!record(context) || !Array.isArray(context.keywordSets)) {
      return 'invalid-evidence';
    }
    if (context.keywordSets.length > MAX_VARIANT_KEYWORD_SETS_PER_CONTEXT) {
      return 'evidence-limit-exceeded';
    }
    keywordSetCount += context.keywordSets.length;
    if (keywordSetCount > MAX_TOTAL_VARIANT_KEYWORD_SETS) {
      return 'evidence-limit-exceeded';
    }
    if (!validContext(context)) return 'invalid-evidence';
    const contextKey = JSON.stringify([
      context.shaderName,
      context.subShaderIndex,
      context.passIndex !== undefined
        ? ['index', context.passIndex]
        : ['name', context.passName ?? null],
      context.stage,
      context.graphicsApi,
    ]);
    if (contextKeys.has(contextKey)) return 'invalid-evidence';
    contextKeys.add(contextKey);

    const keywordSetKeys = new Set<string>();
    for (const keywordSet of context.keywordSets) {
      if (!record(keywordSet)) return 'invalid-evidence';
      if (!Array.isArray(keywordSet.keywords)) return 'invalid-evidence';
      if (keywordSet.keywords.length > MAX_VARIANT_KEYWORDS_PER_SET) {
        return 'evidence-limit-exceeded';
      }
      if (!validKeywordSet(keywordSet)) return 'invalid-evidence';
      if (keywordSet.stage !== undefined && keywordSet.stage !== context.stage) {
        return 'invalid-evidence';
      }
      const keywordSetKey = JSON.stringify([
        [...keywordSet.keywords].sort(),
        keywordSet.scope,
        keywordSet.stage ?? null,
        keywordSet.hasBlankOption,
      ]);
      if (keywordSetKeys.has(keywordSetKey)) return 'invalid-evidence';
      keywordSetKeys.add(keywordSetKey);
    }
  }
  return undefined;
}

function validFailure(status: unknown, failure: unknown): boolean {
  if (status === 'completed') return failure === undefined;
  return record(failure)
    && FAILURE_PHASES.has(string(failure.phase))
    && nonEmptyString(failure.message);
}

function validProvenance(value: unknown): boolean {
  if (!record(value) || !record(value.sourceRevision)) return false;
  return nonEmptyString(value.capability)
    && nonEmptyString(value.projectId)
    && nonEmptyString(value.instanceId)
    && nonEmptyString(value.adapterVersion)
    && nonEmptyString(value.unityVersion)
    && nonEmptyString(value.buildTarget)
    && typeof value.collectedAt === 'number'
    && Number.isFinite(value.collectedAt)
    && value.collectedAt >= 0
    && nonEmptyString(value.sourceRevision.uri)
    && nonEmptyString(value.sourceRevision.assetGuid)
    && nonEmptyString(value.sourceRevision.contentHash);
}

function validContext(value: Record<string, unknown>): boolean {
  return nonEmptyString(value.shaderName)
    && nonNegativeInteger(value.subShaderIndex)
    && (value.passIndex === undefined || nonNegativeInteger(value.passIndex))
    && (value.passName === undefined || nonEmptyString(value.passName))
    && SHADER_STAGES.has(string(value.stage))
    && nonEmptyString(value.graphicsApi)
    && validMeasuredPair(value.compileCandidates, value.kept);
}

function validKeywordSet(value: Record<string, unknown>): boolean {
  const keywords = value.keywords as unknown[];
  const unique = new Set<string>();
  for (const keyword of keywords) {
    if (
      typeof keyword !== 'string'
      || !IDENTIFIER.test(keyword)
      || /^_+$/.test(keyword)
      || unique.has(keyword)
    ) return false;
    unique.add(keyword);
  }
  return (value.scope === 'global' || value.scope === 'local')
    && (value.stage === undefined || SHADER_STAGES.has(string(value.stage)))
    && typeof value.hasBlankOption === 'boolean'
    && (keywords.length > 0 || value.hasBlankOption === true)
    && validMeasuredPair(value.compileCandidates, value.kept);
}

function validMeasuredPair(candidates: unknown, kept: unknown): boolean {
  if (!validMeasuredCount(candidates) || !validMeasuredCount(kept)) return false;
  if (
    record(candidates)
    && candidates.availability === 'available'
    && record(kept)
    && kept.availability === 'available'
  ) return BigInt(kept.count as string) <= BigInt(candidates.count as string);
  return true;
}

function validMeasuredCount(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.availability === 'available') {
    return typeof value.count === 'string'
      && NON_NEGATIVE_INTEGER.test(value.count);
  }
  return value.availability === 'unavailable'
    && UNAVAILABLE_REASONS.has(string(value.reason));
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

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}
