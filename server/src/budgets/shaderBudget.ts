import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ShaderStage,
  VariantBuildEvidence,
  VariantComparisonReport,
  VariantContextComparison,
  VariantKeywordSetComparison,
} from '@unity-shader-nav/shared';
import { createVariantComparisonReport } from '../adapter/variantComparison';
import { validateVariantBuildEvidence } from '../adapter/variantBuildEvidenceSource';

const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;
const SHADER_STAGES = new Set<ShaderStage>([
  'vertex',
  'fragment',
  'geometry',
  'hull',
  'domain',
  'surface',
  'kernel',
  'raytracing',
]);

export interface ShaderBudgetSelector {
  readonly shaderName: string;
  readonly subShaderIndex?: number;
  readonly passIndex?: number;
  readonly passName?: string;
  readonly stage?: ShaderStage;
  readonly buildTarget?: string;
  readonly graphicsApi?: string;
}

export interface ShaderBudgetLimits {
  readonly declaredMax?: string;
  readonly keptMax?: string;
  readonly declaredMaxDelta?: string;
  readonly keptMaxDelta?: string;
}

export interface ShaderBudgetSnapshotEntry {
  readonly key: string;
  readonly count: string;
}

export interface ShaderBudgetMeasurementBaseline {
  readonly count: string;
  readonly contexts: readonly ShaderBudgetSnapshotEntry[];
  readonly keywordSets: readonly ShaderBudgetSnapshotEntry[];
}

export interface ShaderBudgetBaseline {
  readonly declared?: ShaderBudgetMeasurementBaseline;
  readonly kept?: ShaderBudgetMeasurementBaseline;
}

export interface ShaderBudgetPolicy {
  readonly contextChanges: 'fail' | 'allow';
  readonly keywordSetChanges: 'fail' | 'allow';
}

export interface ShaderBudgetEntry {
  readonly id: string;
  readonly source: string;
  readonly selector: ShaderBudgetSelector;
  readonly evidence?: string;
  readonly limits: ShaderBudgetLimits;
  readonly policy: ShaderBudgetPolicy;
  readonly baseline?: ShaderBudgetBaseline;
}

export interface ShaderBudgetContract {
  readonly schemaVersion: 1;
  readonly budgets: readonly ShaderBudgetEntry[];
}

export interface ShaderBudgetDelta {
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly delta?: string;
}

export interface ShaderBudgetMeasurementReport {
  readonly status: 'pass' | 'failed' | 'unverified';
  readonly count?: string;
  readonly max?: string;
  readonly baseline?: string;
  readonly delta?: string;
  readonly maxDelta?: string;
  readonly reason?: string;
  readonly violations: readonly string[];
  readonly contextDeltas: readonly ShaderBudgetDelta[];
  readonly keywordSetDeltas: readonly ShaderBudgetDelta[];
  readonly snapshot?: ShaderBudgetMeasurementBaseline;
}

export interface ShaderBudgetResult {
  readonly id: string;
  readonly source: string;
  readonly selector: ShaderBudgetSelector;
  readonly status: 'pass' | 'failed' | 'unverified';
  readonly declared?: ShaderBudgetMeasurementReport;
  readonly kept?: ShaderBudgetMeasurementReport;
}

export interface ShaderBudgetReport {
  readonly schemaVersion: 1;
  readonly status: 'pass' | 'failed' | 'unverified';
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly unverified: number;
  };
  readonly budgets: readonly ShaderBudgetResult[];
}

export interface ShaderBudgetIo {
  readText(path: string): Promise<string>;
}

const defaultIo: ShaderBudgetIo = {
  readText: (path) => readFile(path, 'utf8'),
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function integerString(value: unknown): value is string {
  return typeof value === 'string' && NON_NEGATIVE_INTEGER.test(value);
}

function optionalIndex(value: unknown): value is number | undefined {
  return value === undefined
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function parseSelector(value: unknown, id: string): ShaderBudgetSelector {
  if (!record(value) || !nonEmptyString(value.shaderName)) {
    throw new Error(`Budget '${id}' requires selector.shaderName.`);
  }
  if (
    !optionalIndex(value.subShaderIndex)
    || !optionalIndex(value.passIndex)
    || (value.passName !== undefined && !nonEmptyString(value.passName))
    || (
      value.stage !== undefined
      && (
        typeof value.stage !== 'string'
        || !SHADER_STAGES.has(value.stage as ShaderStage)
      )
    )
    || (value.buildTarget !== undefined && !nonEmptyString(value.buildTarget))
    || (value.graphicsApi !== undefined && !nonEmptyString(value.graphicsApi))
  ) {
    throw new Error(`Budget '${id}' has an invalid selector.`);
  }
  return {
    shaderName: value.shaderName,
    ...(value.subShaderIndex !== undefined
      ? { subShaderIndex: value.subShaderIndex as number }
      : {}),
    ...(value.passIndex !== undefined ? { passIndex: value.passIndex as number } : {}),
    ...(value.passName !== undefined ? { passName: value.passName as string } : {}),
    ...(value.stage !== undefined ? { stage: value.stage as ShaderStage } : {}),
    ...(value.buildTarget !== undefined
      ? { buildTarget: value.buildTarget as string }
      : {}),
    ...(value.graphicsApi !== undefined
      ? { graphicsApi: value.graphicsApi as string }
      : {}),
  };
}

function parseLimits(value: unknown, id: string): ShaderBudgetLimits {
  if (!record(value)) throw new Error(`Budget '${id}' requires limits.`);
  for (const key of [
    'declaredMax',
    'keptMax',
    'declaredMaxDelta',
    'keptMaxDelta',
  ] as const) {
    if (value[key] !== undefined && !integerString(value[key])) {
      throw new Error(`Budget '${id}' has invalid limits.${key}; use a decimal string.`);
    }
  }
  if (
    value.declaredMax === undefined
    && value.keptMax === undefined
    && value.declaredMaxDelta === undefined
    && value.keptMaxDelta === undefined
  ) {
    throw new Error(`Budget '${id}' must define at least one declared or kept limit.`);
  }
  return {
    ...(value.declaredMax !== undefined
      ? { declaredMax: value.declaredMax as string }
      : {}),
    ...(value.keptMax !== undefined ? { keptMax: value.keptMax as string } : {}),
    ...(value.declaredMaxDelta !== undefined
      ? { declaredMaxDelta: value.declaredMaxDelta as string }
      : {}),
    ...(value.keptMaxDelta !== undefined
      ? { keptMaxDelta: value.keptMaxDelta as string }
      : {}),
  };
}

function parseSnapshotEntries(
  value: unknown,
  path: string,
): ShaderBudgetSnapshotEntry[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const result: ShaderBudgetSnapshotEntry[] = [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (
      !record(entry)
      || !nonEmptyString(entry.key)
      || !integerString(entry.count)
      || keys.has(entry.key)
    ) {
      throw new Error(`${path} contains an invalid or duplicate entry.`);
    }
    keys.add(entry.key);
    result.push({ key: entry.key, count: entry.count });
  }
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function parseMeasurementBaseline(
  value: unknown,
  path: string,
): ShaderBudgetMeasurementBaseline {
  if (!record(value) || !integerString(value.count)) {
    throw new Error(`${path} requires a decimal count.`);
  }
  return {
    count: value.count,
    contexts: parseSnapshotEntries(value.contexts, `${path}.contexts`),
    keywordSets: parseSnapshotEntries(value.keywordSets, `${path}.keywordSets`),
  };
}

function parseBaseline(value: unknown, id: string): ShaderBudgetBaseline | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error(`Budget '${id}' baseline must be an object.`);
  if (value.declared === undefined && value.kept === undefined) {
    throw new Error(`Budget '${id}' baseline is empty.`);
  }
  return {
    ...(value.declared !== undefined
      ? {
          declared: parseMeasurementBaseline(
            value.declared,
            `Budget '${id}' baseline.declared`,
          ),
        }
      : {}),
    ...(value.kept !== undefined
      ? {
          kept: parseMeasurementBaseline(
            value.kept,
            `Budget '${id}' baseline.kept`,
          ),
        }
      : {}),
  };
}

function parsePolicy(value: unknown, id: string): ShaderBudgetPolicy {
  if (value === undefined) {
    return { contextChanges: 'fail', keywordSetChanges: 'fail' };
  }
  if (!record(value)) throw new Error(`Budget '${id}' policy must be an object.`);
  const contextChanges = value.contextChanges ?? 'fail';
  const keywordSetChanges = value.keywordSetChanges ?? 'fail';
  if (
    (contextChanges !== 'fail' && contextChanges !== 'allow')
    || (keywordSetChanges !== 'fail' && keywordSetChanges !== 'allow')
  ) {
    throw new Error(`Budget '${id}' policy values must be 'fail' or 'allow'.`);
  }
  return { contextChanges, keywordSetChanges };
}

export function parseShaderBudgetContract(value: unknown): ShaderBudgetContract {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.budgets)) {
    throw new Error('Shader budget contract requires schemaVersion 1 and a budgets array.');
  }
  if (value.budgets.length === 0) {
    throw new Error('Shader budget contract must define at least one budget.');
  }
  const ids = new Set<string>();
  const budgets = value.budgets.map((candidate, index): ShaderBudgetEntry => {
    if (
      !record(candidate)
      || !nonEmptyString(candidate.id)
      || ids.has(candidate.id)
      || !nonEmptyString(candidate.source)
      || (candidate.evidence !== undefined && !nonEmptyString(candidate.evidence))
    ) {
      throw new Error(`Shader budget at index ${index} is malformed or has a duplicate id.`);
    }
    ids.add(candidate.id);
    const limits = parseLimits(candidate.limits, candidate.id);
    const baseline = parseBaseline(candidate.baseline, candidate.id);
    if (
      (limits.keptMax !== undefined || limits.keptMaxDelta !== undefined)
      && candidate.evidence === undefined
    ) {
      throw new Error(`Budget '${candidate.id}' requires an evidence path for kept limits.`);
    }
    return {
      id: candidate.id,
      source: candidate.source,
      selector: parseSelector(candidate.selector, candidate.id),
      ...(candidate.evidence !== undefined
        ? { evidence: candidate.evidence as string }
        : {}),
      limits,
      policy: parsePolicy(candidate.policy, candidate.id),
      ...(baseline ? { baseline } : {}),
    };
  });
  return {
    schemaVersion: 1,
    budgets: budgets.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function contextMatches(
  comparison: VariantContextComparison,
  selector: ShaderBudgetSelector,
  includePlatform: boolean,
): boolean {
  const context = comparison.context;
  return context.shaderName === selector.shaderName
    && (
      selector.subShaderIndex === undefined
      || context.subShaderIndex === selector.subShaderIndex
    )
    && (selector.passIndex === undefined || context.passIndex === selector.passIndex)
    && (selector.passName === undefined || context.passName === selector.passName)
    && (selector.stage === undefined || context.stage === selector.stage)
    && (
      !includePlatform
      || selector.buildTarget === undefined
      || context.buildTarget === selector.buildTarget
    )
    && (
      !includePlatform
      || selector.graphicsApi === undefined
      || context.graphicsApi === selector.graphicsApi
    );
}

function contextKey(
  comparison: VariantContextComparison,
  includePlatform: boolean,
): string {
  const context = comparison.context;
  return [
    context.shaderName,
    `SubShader ${context.subShaderIndex}`,
    context.passIndex !== undefined
      ? `Pass ${context.passIndex}${context.passName ? ` ${context.passName}` : ''}`
      : `Pass ${context.passName ?? '<none>'}`,
    context.stage,
    ...(includePlatform ? [context.buildTarget, context.graphicsApi] : []),
  ].join(' | ');
}

function keywordSetKey(
  context: string,
  comparison: VariantKeywordSetComparison,
): string {
  const identity = comparison.identity;
  const options = [
    ...(identity.hasBlankOption ? ['<blank>'] : []),
    ...identity.keywords,
  ].join(' / ');
  return [
    context,
    `${identity.scope}${identity.stage ? `/${identity.stage}` : ''}`,
    options,
  ].join(' | ');
}

function addCount(
  map: Map<string, bigint>,
  key: string,
  count: string,
): void {
  map.set(key, (map.get(key) ?? 0n) + BigInt(count));
}

function snapshotEntries(map: ReadonlyMap<string, bigint>): ShaderBudgetSnapshotEntry[] {
  return [...map]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ key, count: count.toString() }));
}

function measurementSnapshot(
  report: VariantComparisonReport,
  selector: ShaderBudgetSelector,
  measurement: 'declared' | 'kept',
): { readonly snapshot?: ShaderBudgetMeasurementBaseline; readonly reason?: string } {
  const includePlatform = measurement === 'kept';
  const matches = report.comparisons.filter((comparison) => (
    contextMatches(comparison, selector, includePlatform)
  ));
  if (matches.length === 0) {
    return { reason: 'no matching Shader/Pass/Stage/platform Context' };
  }
  const contexts = new Map<string, bigint>();
  const keywordSets = new Map<string, bigint>();
  let total = 0n;
  for (const comparison of matches) {
    const evidence = comparison[measurement];
    if (evidence.availability !== 'available') {
      return {
        reason: `${contextKey(comparison, includePlatform)} is ${evidence.reason}`,
      };
    }
    const key = contextKey(comparison, includePlatform);
    addCount(contexts, key, evidence.count);
    total += BigInt(evidence.count);
    for (const keywordSet of comparison.keywordSets) {
      const setEvidence = keywordSet[measurement];
      if (setEvidence.availability !== 'available') {
        return {
          reason: `${keywordSetKey(key, keywordSet)} is ${setEvidence.reason}`,
        };
      }
      addCount(keywordSets, keywordSetKey(key, keywordSet), setEvidence.count);
    }
  }
  return {
    snapshot: {
      count: total.toString(),
      contexts: snapshotEntries(contexts),
      keywordSets: snapshotEntries(keywordSets),
    },
  };
}

function deltas(
  before: readonly ShaderBudgetSnapshotEntry[],
  after: readonly ShaderBudgetSnapshotEntry[],
): ShaderBudgetDelta[] {
  const beforeByKey = new Map(before.map((entry) => [entry.key, entry.count]));
  const afterByKey = new Map(after.map((entry) => [entry.key, entry.count]));
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  return keys.flatMap((key) => {
    const previous = beforeByKey.get(key);
    const current = afterByKey.get(key);
    if (previous === current) return [];
    return [{
      key,
      before: previous ?? null,
      after: current ?? null,
      ...(previous !== undefined && current !== undefined
        ? { delta: (BigInt(current) - BigInt(previous)).toString() }
        : {}),
    }];
  });
}

function signed(value: bigint): string {
  return value > 0n ? `+${value}` : value.toString();
}

function evaluateMeasurement(input: {
  readonly snapshot?: ShaderBudgetMeasurementBaseline;
  readonly unavailableReason?: string;
  readonly max?: string;
  readonly maxDelta?: string;
  readonly baseline?: ShaderBudgetMeasurementBaseline;
  readonly policy: ShaderBudgetPolicy;
}): ShaderBudgetMeasurementReport {
  if (!input.snapshot) {
    return {
      status: 'unverified',
      reason: input.unavailableReason ?? 'measurement is unavailable',
      violations: [],
      contextDeltas: [],
      keywordSetDeltas: [],
    };
  }
  const violations: string[] = [];
  const current = BigInt(input.snapshot.count);
  if (input.max !== undefined && current > BigInt(input.max)) {
    violations.push(`count ${current} exceeds max ${input.max}`);
  }
  if (input.maxDelta !== undefined && !input.baseline) {
    return {
      status: violations.length > 0 ? 'failed' : 'unverified',
      count: input.snapshot.count,
      ...(input.max !== undefined ? { max: input.max } : {}),
      maxDelta: input.maxDelta,
      reason: 'a baseline is required before delta can be verified',
      violations,
      contextDeltas: [],
      keywordSetDeltas: [],
      snapshot: input.snapshot,
    };
  }
  const delta = input.baseline
    ? current - BigInt(input.baseline.count)
    : undefined;
  if (
    delta !== undefined
    && input.maxDelta !== undefined
    && delta > BigInt(input.maxDelta)
  ) {
    violations.push(
      `delta ${signed(delta)} exceeds max delta +${input.maxDelta}`,
    );
  }
  const contextDeltas = input.baseline
    ? deltas(input.baseline.contexts, input.snapshot.contexts)
    : [];
  const keywordSetDeltas = input.baseline
    ? deltas(input.baseline.keywordSets, input.snapshot.keywordSets)
    : [];
  const contextInventoryChanges = contextDeltas.filter((change) => (
    change.before === null || change.after === null
  ));
  const keywordSetInventoryChanges = keywordSetDeltas.filter((change) => (
    change.before === null || change.after === null
  ));
  if (
    input.policy.contextChanges === 'fail'
    && contextInventoryChanges.length > 0
  ) {
    violations.push(
      `${contextInventoryChanges.length} source Context inventory change(s) require baseline review`,
    );
  }
  if (
    input.policy.keywordSetChanges === 'fail'
    && keywordSetInventoryChanges.length > 0
  ) {
    violations.push(
      `${keywordSetInventoryChanges.length} keyword-set inventory change(s) require baseline review`,
    );
  }
  return {
    status: violations.length > 0 ? 'failed' : 'pass',
    count: input.snapshot.count,
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(input.baseline ? { baseline: input.baseline.count } : {}),
    ...(delta !== undefined ? { delta: delta.toString() } : {}),
    ...(input.maxDelta !== undefined ? { maxDelta: input.maxDelta } : {}),
    violations,
    contextDeltas,
    keywordSetDeltas,
    snapshot: input.snapshot,
  };
}

function resultStatus(
  measurements: readonly (ShaderBudgetMeasurementReport | undefined)[],
): ShaderBudgetResult['status'] {
  if (measurements.some((measurement) => measurement?.status === 'failed')) {
    return 'failed';
  }
  if (measurements.some((measurement) => measurement?.status === 'unverified')) {
    return 'unverified';
  }
  return 'pass';
}

async function readEvidence(
  path: string,
  sourceText: string,
  io: ShaderBudgetIo,
): Promise<
  | { readonly evidence: VariantBuildEvidence }
  | { readonly reason: string }
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await io.readText(path));
  } catch (error) {
    return {
      reason: error instanceof Error
        ? `build evidence cannot be read: ${error.message}`
        : 'build evidence cannot be read',
    };
  }
  const invalid = validateVariantBuildEvidence(parsed);
  if (invalid) return { reason: `build evidence is ${invalid}` };
  const evidence = parsed as VariantBuildEvidence;
  if (evidence.provenance.capability !== 'variant-build-evidence') {
    return { reason: 'build evidence has the wrong capability' };
  }
  if (evidence.status !== 'completed') {
    return { reason: `build evidence status is ${evidence.status}` };
  }
  if (evidence.provenance.sourceRevision.contentHash !== contentHash(sourceText)) {
    return { reason: 'build evidence source hash does not match current Shader source' };
  }
  return { evidence };
}

export async function evaluateShaderBudgets(
  contract: ShaderBudgetContract,
  contractDirectory: string,
  io: ShaderBudgetIo = defaultIo,
): Promise<ShaderBudgetReport> {
  const budgets: ShaderBudgetResult[] = [];
  for (const budget of contract.budgets) {
    const sourcePath = resolve(contractDirectory, budget.source);
    let sourceText: string;
    try {
      sourceText = await io.readText(sourcePath);
    } catch (error) {
      const reason = error instanceof Error
        ? `Shader source cannot be read: ${error.message}`
        : 'Shader source cannot be read';
      const unverified = (): ShaderBudgetMeasurementReport => ({
        status: 'unverified',
        reason,
        violations: [],
        contextDeltas: [],
        keywordSetDeltas: [],
      });
      const declared = budget.limits.declaredMax !== undefined
        || budget.limits.declaredMaxDelta !== undefined
        ? unverified()
        : undefined;
      const kept = budget.limits.keptMax !== undefined
        || budget.limits.keptMaxDelta !== undefined
        ? unverified()
        : undefined;
      budgets.push({
        id: budget.id,
        source: budget.source,
        selector: budget.selector,
        status: 'unverified',
        ...(declared ? { declared } : {}),
        ...(kept ? { kept } : {}),
      });
      continue;
    }

    const needsDeclared = budget.limits.declaredMax !== undefined
      || budget.limits.declaredMaxDelta !== undefined;
    const needsKept = budget.limits.keptMax !== undefined
      || budget.limits.keptMaxDelta !== undefined;
    const staticReport = createVariantComparisonReport(
      sourcePath,
      sourceText,
      { availability: 'unavailable', reason: 'source-unavailable' },
    );
    const declaredSnapshot = needsDeclared
      ? measurementSnapshot(staticReport, budget.selector, 'declared')
      : undefined;
    const declared = needsDeclared
      ? evaluateMeasurement({
          snapshot: declaredSnapshot?.snapshot,
          unavailableReason: declaredSnapshot?.reason,
          max: budget.limits.declaredMax,
          maxDelta: budget.limits.declaredMaxDelta,
          baseline: budget.baseline?.declared,
          policy: budget.policy,
        })
      : undefined;

    let kept: ShaderBudgetMeasurementReport | undefined;
    if (needsKept) {
      const evidenceResult = await readEvidence(
        resolve(contractDirectory, budget.evidence!),
        sourceText,
        io,
      );
      if ('reason' in evidenceResult) {
        kept = evaluateMeasurement({
          unavailableReason: evidenceResult.reason,
          max: budget.limits.keptMax,
          maxDelta: budget.limits.keptMaxDelta,
          baseline: budget.baseline?.kept,
          policy: budget.policy,
        });
      } else {
        const measuredReport = createVariantComparisonReport(
          sourcePath,
          sourceText,
          { availability: 'available', evidence: evidenceResult.evidence },
        );
        const keptSnapshot = measurementSnapshot(
          measuredReport,
          budget.selector,
          'kept',
        );
        kept = evaluateMeasurement({
          snapshot: keptSnapshot.snapshot,
          unavailableReason: keptSnapshot.reason,
          max: budget.limits.keptMax,
          maxDelta: budget.limits.keptMaxDelta,
          baseline: budget.baseline?.kept,
          policy: budget.policy,
        });
      }
    }
    budgets.push({
      id: budget.id,
      source: budget.source,
      selector: budget.selector,
      status: resultStatus([declared, kept]),
      ...(declared ? { declared } : {}),
      ...(kept ? { kept } : {}),
    });
  }

  const summary = {
    total: budgets.length,
    passed: budgets.filter(({ status }) => status === 'pass').length,
    failed: budgets.filter(({ status }) => status === 'failed').length,
    unverified: budgets.filter(({ status }) => status === 'unverified').length,
  };
  return {
    schemaVersion: 1,
    status: summary.failed > 0
      ? 'failed'
      : summary.unverified > 0
        ? 'unverified'
        : 'pass',
    summary,
    budgets,
  };
}

export function contractWithCurrentBaselines(
  contract: ShaderBudgetContract,
  report: ShaderBudgetReport,
): ShaderBudgetContract {
  const resultById = new Map(report.budgets.map((budget) => [budget.id, budget]));
  return {
    schemaVersion: 1,
    budgets: contract.budgets.map((budget) => {
      const result = resultById.get(budget.id);
      const declared = result?.declared?.snapshot;
      const kept = result?.kept?.snapshot;
      if (
        (result?.declared && !declared)
        || (result?.kept && !kept)
      ) {
        throw new Error(
          `Cannot write baseline for '${budget.id}': a required measurement is unverified.`,
        );
      }
      return {
        ...budget,
        baseline: {
          ...(declared ? { declared } : {}),
          ...(kept ? { kept } : {}),
        },
      };
    }),
  };
}

function deltaDetails(label: string, deltas: readonly ShaderBudgetDelta[]): string[] {
  return deltas.map((delta) => (
    `    ${label}: ${delta.key}: ${delta.before ?? '<added>'} -> `
    + `${delta.after ?? '<removed>'}`
    + (delta.delta !== undefined ? ` (${signed(BigInt(delta.delta))})` : '')
  ));
}

export function formatShaderBudgetReport(report: ShaderBudgetReport): string {
  const lines = [
    `Shader budget verification: ${report.status.toUpperCase()} `
      + `(${report.summary.passed} passed, ${report.summary.failed} failed, `
      + `${report.summary.unverified} unverified)`,
  ];
  for (const budget of report.budgets) {
    lines.push(`[${budget.status.toUpperCase()}] ${budget.id} — ${budget.source}`);
    for (const [name, measurement] of [
      ['declared', budget.declared],
      ['kept', budget.kept],
    ] as const) {
      if (!measurement) continue;
      if (measurement.status === 'unverified') {
        lines.push(`  ${name}: UNVERIFIED — ${measurement.reason}`);
        continue;
      }
      lines.push(
        `  ${name}: ${measurement.count}`
        + (measurement.max !== undefined ? ` / max ${measurement.max}` : '')
        + (measurement.baseline !== undefined
          ? ` / baseline ${measurement.baseline} / delta ${signed(BigInt(measurement.delta!))}`
          : ''),
      );
      for (const violation of measurement.violations) {
        lines.push(`    violation: ${violation}`);
      }
      lines.push(...deltaDetails('Context', measurement.contextDeltas));
      lines.push(...deltaDetails('keyword set', measurement.keywordSetDeltas));
    }
  }
  return lines.join('\n');
}
