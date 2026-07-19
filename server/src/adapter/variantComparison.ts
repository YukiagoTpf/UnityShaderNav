import { createHash } from 'node:crypto';
import type {
  CompileCandidateVariantEvidence,
  DeclaredVariantEvidence,
  KeptVariantEvidence,
  LargestDeclaredToKeptGap,
  ShaderStage,
  VariantBuildContextEvidence,
  VariantBuildEvidenceResult,
  VariantComparisonContext,
  VariantComparisonMeasurementUnavailableReason,
  VariantComparisonReport,
  VariantContextComparison,
  VariantKeywordSetBuildEvidence,
  VariantKeywordSetComparison,
  VariantKeywordSetIdentity,
  VariantMeasuredCount,
} from '@unity-shader-nav/shared';
import { UNKNOWN_VARIANT_CONTEXT_DIMENSION } from '@unity-shader-nav/shared';
import { analyzeDocument } from '../analysis/documentAnalysis';
import {
  analyzeDeclaredVariantCosts,
  type DeclaredVariantContribution,
} from '../parser/preproc/declaredVariantCost';
import { scanShaderContextSource } from '../parser/preproc/scanShaderContext';

const MAX_LARGEST_GAPS = 20;

interface StaticKeywordSet {
  readonly identity: VariantKeywordSetIdentity;
  readonly multiplier: string;
}

interface StaticVariantContext {
  readonly context: Omit<VariantComparisonContext, 'buildTarget' | 'graphicsApi'>;
  readonly upperBound: string;
  readonly keywordSets: readonly StaticKeywordSet[];
}

export function variantSourceHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Join source-derived estimates with already validated Adapter evidence. */
export function createVariantComparisonReport(
  uri: string,
  text: string,
  buildResult: VariantBuildEvidenceResult,
): VariantComparisonReport {
  const staticContexts = declaredContexts(uri, text);
  const comparisons: VariantContextComparison[] = [];

  if (buildResult.availability === 'unavailable') {
    for (const source of staticContexts) {
      comparisons.push(staticOnlyComparison(source, buildResult.reason));
    }
  } else {
    const matchedBuildContexts = new Set<VariantBuildContextEvidence>();
    for (const source of staticContexts) {
      const matches = buildResult.evidence.contexts.filter((candidate) => (
        contextMatches(source.context, candidate)
      ));
      if (matches.length === 0) {
        comparisons.push(staticOnlyComparison(
          source,
          'no-matching-build-context',
          buildResult.evidence.provenance.buildTarget,
        ));
        continue;
      }
      for (const measured of matches) {
        matchedBuildContexts.add(measured);
        comparisons.push(combineContext(
          source,
          measured,
          buildResult.evidence.provenance.buildTarget,
        ));
      }
    }
    for (const measured of buildResult.evidence.contexts) {
      if (!matchedBuildContexts.has(measured)) {
        comparisons.push(buildOnlyComparison(
          measured,
          buildResult.evidence.provenance.buildTarget,
        ));
      }
    }
  }

  const gaps = comparisons
    .flatMap(largestGapsFromComparison)
    .sort(compareLargestGap)
    .slice(0, MAX_LARGEST_GAPS);
  return {
    currentSource: { uri, contentHash: variantSourceHash(text) },
    build: buildResult.availability === 'available'
      ? {
          availability: 'available',
          status: buildResult.evidence.status,
          provenance: {
            ...buildResult.evidence.provenance,
            sourceRevision: {
              ...buildResult.evidence.provenance.sourceRevision,
            },
          },
          ...(buildResult.evidence.failure
            ? { failure: { ...buildResult.evidence.failure } }
            : {}),
        }
      : { ...buildResult },
    comparisons,
    largestDeclaredToKeptGaps: gaps,
  };
}

function declaredContexts(uri: string, text: string): StaticVariantContext[] {
  const document = analyzeDocument(uri, text, 'index');
  if (!document) return [];
  const analysis = analyzeDeclaredVariantCosts(text, true);
  const programs = scanShaderContextSource(
    document,
    document.blocks,
    document.structure,
  ).programs ?? [];
  const costByStartLine = new Map(
    analysis.programs.map((cost) => [cost.startLine, cost]),
  );
  const result: StaticVariantContext[] = [];

  for (const program of programs) {
    const block = document.blocks[program.blockIndex];
    const cost = block ? costByStartLine.get(block.startLine) : undefined;
    if (!cost) continue;
    for (const stage of program.stages) {
      const contributions = cost.contributions.filter((contribution) => (
        !contribution.duplicateSet
        && appliesToStage(contribution, stage.stage)
      ));
      let upperBound = 1n;
      for (const contribution of contributions) {
        upperBound *= BigInt(contribution.effectiveMultiplier);
      }
      result.push({
        context: {
          shaderName: program.shaderName,
          subShaderIndex: program.subShaderIndex,
          ...(program.passIndex !== undefined ? { passIndex: program.passIndex } : {}),
          ...(program.passName ? { passName: program.passName } : {}),
          stage: stage.stage,
          sourceLine: cost.startLine,
        },
        upperBound: upperBound.toString(),
        keywordSets: contributions.map(({ pragma }) => ({
          identity: {
            keywords: [...pragma.keywords],
            scope: pragma.local ? 'local' : 'global',
            ...(pragma.stage ? { stage: pragma.stage } : {}),
            hasBlankOption: pragma.hasBlankOption,
          },
          multiplier: pragma.multiplier.toString(),
        })),
      });
    }
  }
  return result;
}

function appliesToStage(
  contribution: DeclaredVariantContribution,
  stage: ShaderStage,
): boolean {
  return contribution.pragma.stage === undefined
    || contribution.pragma.stage === stage;
}

function contextMatches(
  source: StaticVariantContext['context'],
  measured: VariantBuildContextEvidence,
): boolean {
  return source.shaderName === measured.shaderName
    && source.subShaderIndex === measured.subShaderIndex
    && source.passIndex === measured.passIndex
    && source.stage === measured.stage;
}

function staticOnlyComparison(
  source: StaticVariantContext,
  reason: VariantComparisonMeasurementUnavailableReason,
  buildTarget = UNKNOWN_VARIANT_CONTEXT_DIMENSION,
): VariantContextComparison {
  return {
    context: {
      ...source.context,
      buildTarget,
      graphicsApi: UNKNOWN_VARIANT_CONTEXT_DIMENSION,
    },
    declared: availableDeclared('static-upper-bound', source.upperBound),
    compileCandidates: unavailableMeasured('compile-candidates', reason),
    kept: unavailableMeasured('kept', reason),
    keywordSets: source.keywordSets.map((keywordSet) => ({
      identity: keywordSet.identity,
      declared: availableDeclared('static-set-multiplier', keywordSet.multiplier),
      compileCandidates: unavailableMeasured('compile-candidates', reason),
      kept: unavailableMeasured('kept', reason),
    })),
  };
}

function combineContext(
  source: StaticVariantContext,
  measured: VariantBuildContextEvidence,
  buildTarget: string,
): VariantContextComparison {
  return {
    context: comparisonContext(source.context, measured, buildTarget),
    declared: availableDeclared('static-upper-bound', source.upperBound),
    compileCandidates: measuredEvidence('compile-candidates', measured.compileCandidates),
    kept: measuredEvidence('kept', measured.kept),
    keywordSets: combineKeywordSets(source.keywordSets, measured.keywordSets),
  };
}

function buildOnlyComparison(
  measured: VariantBuildContextEvidence,
  buildTarget: string,
): VariantContextComparison {
  return {
    context: {
      shaderName: measured.shaderName,
      subShaderIndex: measured.subShaderIndex,
      ...(measured.passIndex !== undefined ? { passIndex: measured.passIndex } : {}),
      ...(measured.passName ? { passName: measured.passName } : {}),
      stage: measured.stage,
      buildTarget,
      graphicsApi: measured.graphicsApi,
    },
    declared: unavailableDeclared('static-upper-bound'),
    compileCandidates: measuredEvidence('compile-candidates', measured.compileCandidates),
    kept: measuredEvidence('kept', measured.kept),
    keywordSets: measured.keywordSets.map((keywordSet) => ({
      identity: cloneKeywordSetIdentity(keywordSet),
      declared: unavailableDeclared('static-set-multiplier'),
      compileCandidates: measuredEvidence(
        'compile-candidates',
        keywordSet.compileCandidates,
      ),
      kept: measuredEvidence('kept', keywordSet.kept),
    })),
  };
}

function comparisonContext(
  source: StaticVariantContext['context'],
  measured: VariantBuildContextEvidence,
  buildTarget: string,
): VariantComparisonContext {
  return {
    ...source,
    ...(measured.passName ? { passName: measured.passName } : {}),
    buildTarget,
    graphicsApi: measured.graphicsApi,
  };
}

function combineKeywordSets(
  declaredSets: readonly StaticKeywordSet[],
  measuredSets: readonly VariantKeywordSetBuildEvidence[],
): VariantKeywordSetComparison[] {
  const measuredByKey = new Map(
    measuredSets.map((keywordSet) => [keywordSetKey(keywordSet), keywordSet]),
  );
  const used = new Set<string>();
  const comparisons: VariantKeywordSetComparison[] = [];

  for (const declared of declaredSets) {
    const key = keywordSetKey(declared.identity);
    const measured = measuredByKey.get(key);
    used.add(key);
    comparisons.push(keywordSetComparison(declared, measured));
  }
  for (const measured of measuredSets) {
    const key = keywordSetKey(measured);
    if (used.has(key)) continue;
    comparisons.push(keywordSetComparison(undefined, measured));
  }
  return comparisons.sort(compareKeywordSetGap);
}

function keywordSetComparison(
  declared: StaticKeywordSet | undefined,
  measured: VariantKeywordSetBuildEvidence | undefined,
): VariantKeywordSetComparison {
  const declaredEvidence = declared
    ? availableDeclared('static-set-multiplier', declared.multiplier)
    : unavailableDeclared('static-set-multiplier');
  const kept = measured
    ? measuredEvidence('kept', measured.kept)
    : unavailableMeasured('kept', 'not-collected');
  return {
    identity: declared?.identity ?? cloneKeywordSetIdentity(measured!),
    declared: declaredEvidence,
    compileCandidates: measured
      ? measuredEvidence('compile-candidates', measured.compileCandidates)
      : unavailableMeasured('compile-candidates', 'not-collected'),
    kept,
    ...(declaredEvidence.availability === 'available' && kept.availability === 'available'
      ? { declaredToKeptGap: (BigInt(declaredEvidence.count) - BigInt(kept.count)).toString() }
      : {}),
  };
}

function availableDeclared(
  basis: Extract<DeclaredVariantEvidence, { availability: 'available' }>['basis'],
  count: string,
): DeclaredVariantEvidence {
  return { evidenceClass: 'declared', basis, availability: 'available', count };
}

function unavailableDeclared(
  basis: DeclaredVariantEvidence['basis'],
): DeclaredVariantEvidence {
  return {
    evidenceClass: 'declared',
    basis,
    availability: 'unavailable',
    reason: 'no-declared-context',
  };
}

function measuredEvidence(
  evidenceClass: 'compile-candidates',
  count: VariantMeasuredCount,
): CompileCandidateVariantEvidence;
function measuredEvidence(
  evidenceClass: 'kept',
  count: VariantMeasuredCount,
): KeptVariantEvidence;
function measuredEvidence(
  evidenceClass: 'compile-candidates' | 'kept',
  count: VariantMeasuredCount,
): CompileCandidateVariantEvidence | KeptVariantEvidence {
  return count.availability === 'available'
    ? { evidenceClass, basis: 'unity-build', availability: 'available', count: count.count }
    : { evidenceClass, basis: 'unity-build', availability: 'unavailable', reason: count.reason };
}

function unavailableMeasured(
  evidenceClass: 'compile-candidates',
  reason: VariantComparisonMeasurementUnavailableReason,
): CompileCandidateVariantEvidence;
function unavailableMeasured(
  evidenceClass: 'kept',
  reason: VariantComparisonMeasurementUnavailableReason,
): KeptVariantEvidence;
function unavailableMeasured(
  evidenceClass: 'compile-candidates' | 'kept',
  reason: VariantComparisonMeasurementUnavailableReason,
): CompileCandidateVariantEvidence | KeptVariantEvidence {
  return { evidenceClass, basis: 'unity-build', availability: 'unavailable', reason };
}

function cloneKeywordSetIdentity(
  keywordSet: VariantKeywordSetIdentity,
): VariantKeywordSetIdentity {
  return {
    keywords: [...keywordSet.keywords],
    scope: keywordSet.scope,
    ...(keywordSet.stage ? { stage: keywordSet.stage } : {}),
    hasBlankOption: keywordSet.hasBlankOption,
  };
}

function keywordSetKey(keywordSet: VariantKeywordSetIdentity): string {
  return JSON.stringify([
    [...keywordSet.keywords].sort(),
    keywordSet.scope,
    keywordSet.stage ?? null,
    keywordSet.hasBlankOption,
  ]);
}

function compareKeywordSetGap(
  left: VariantKeywordSetComparison,
  right: VariantKeywordSetComparison,
): number {
  const leftGap = left.declaredToKeptGap;
  const rightGap = right.declaredToKeptGap;
  if (leftGap !== undefined && rightGap === undefined) return -1;
  if (leftGap === undefined && rightGap !== undefined) return 1;
  if (leftGap !== undefined && rightGap !== undefined) {
    const comparison = compareBigIntDescending(BigInt(leftGap), BigInt(rightGap));
    if (comparison !== 0) return comparison;
  }
  return keywordSetKey(left.identity).localeCompare(keywordSetKey(right.identity));
}

function largestGapsFromComparison(
  comparison: VariantContextComparison,
): LargestDeclaredToKeptGap[] {
  return comparison.keywordSets.flatMap((keywordSet) => {
    if (
      keywordSet.declaredToKeptGap === undefined
      || BigInt(keywordSet.declaredToKeptGap) <= 0n
      || keywordSet.declared.availability !== 'available'
      || keywordSet.kept.availability !== 'available'
    ) return [];
    return [{
      context: comparison.context,
      keywordSet: keywordSet.identity,
      declaredCount: keywordSet.declared.count,
      keptCount: keywordSet.kept.count,
      gap: keywordSet.declaredToKeptGap,
    }];
  });
}

function compareLargestGap(
  left: LargestDeclaredToKeptGap,
  right: LargestDeclaredToKeptGap,
): number {
  return compareBigIntDescending(BigInt(left.gap), BigInt(right.gap))
    || contextKey(left.context).localeCompare(contextKey(right.context))
    || keywordSetKey(left.keywordSet).localeCompare(keywordSetKey(right.keywordSet));
}

function compareBigIntDescending(left: bigint, right: bigint): number {
  return left > right ? -1 : left < right ? 1 : 0;
}

function contextKey(context: VariantComparisonContext): string {
  return JSON.stringify([
    context.shaderName,
    context.subShaderIndex,
    context.passIndex ?? null,
    context.stage,
    context.buildTarget,
    context.graphicsApi,
  ]);
}
