import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AdapterDiagnosticProvenance,
  CompileProfile,
  ShaderMessage,
} from '@unity-shader-nav/shared';
import { SHADER_MESSAGES_CAPABILITY } from '@unity-shader-nav/shared';
import type { Diagnostic } from 'vscode-languageserver/node';
import { MacroPatternRecognizer } from '../macros';
import { indexFile } from '../parser/hlsl';
import {
  type ShaderBudgetContract,
  type ShaderBudgetReport,
  evaluateShaderBudgets,
  parseShaderBudgetContract,
} from '../budgets/shaderBudget';
import { srpBatcherDiagnostics } from '../workspace/materialContracts';

export type VerificationStatus = 'pass' | 'failed' | 'unverified';

export interface CompilerWarningPolicy {
  readonly forbiddenMessageSubstrings: readonly string[];
  readonly baseline: readonly string[];
}

export interface ShaderCompileProfileContract {
  readonly profile: CompileProfile;
  readonly evidence: string;
  readonly warnings: CompilerWarningPolicy;
}

export interface ShaderCompileScopeContract {
  readonly id: string;
  readonly source: string;
  readonly srpBatcher: 'required' | 'ignore';
  readonly profiles: readonly ShaderCompileProfileContract[];
}

export interface ShaderCompileContract {
  readonly schemaVersion: 1;
  readonly policy: {
    readonly unverified: 'fail' | 'allow';
  };
  readonly requiredCapabilities: readonly string[];
  readonly scopes: readonly ShaderCompileScopeContract[];
  readonly variantBudgets: string;
}

export interface CapturedCompileEvidence {
  readonly schemaVersion: 1;
  readonly status: 'completed';
  readonly supportedFeatures: readonly string[];
  readonly profile: CompileProfile;
  readonly durationMs: number;
  readonly provenance: AdapterDiagnosticProvenance;
  readonly diagnostics: readonly ShaderMessage[];
}

export interface CapturedUnavailableEvidence {
  readonly schemaVersion: 1;
  readonly status: 'unavailable';
  readonly reason: string;
}

export interface CompilerDiagnosticSummary {
  readonly fingerprint: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface CompileProfileCheck {
  readonly status: VerificationStatus;
  readonly profile: CompileProfile;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly warnings: readonly CompilerDiagnosticSummary[];
  readonly errors: readonly CompilerDiagnosticSummary[];
  readonly newWarnings: readonly string[];
  readonly resolvedWarnings: readonly string[];
  readonly violations: readonly string[];
}

export interface SrpBatcherCheck {
  readonly status: VerificationStatus;
  readonly reason?: string;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly line: number;
  }[];
}

export interface ShaderCompileScopeCheck {
  readonly id: string;
  readonly source: string;
  readonly status: VerificationStatus;
  readonly srpBatcher: SrpBatcherCheck;
  readonly profiles: readonly CompileProfileCheck[];
}

export interface ShaderCompileReport {
  readonly schemaVersion: 1;
  readonly status: VerificationStatus;
  readonly policy: ShaderCompileContract['policy'];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly unverified: number;
  };
  readonly scopes: readonly ShaderCompileScopeCheck[];
  readonly variantBudgets: {
    readonly contract: string;
    readonly report: ShaderBudgetReport;
    readonly reason?: string;
  };
}

export interface ShaderCompileIo {
  readText(path: string): Promise<string>;
}

const defaultIo: ShaderCompileIo = {
  readText: (path) => readFile(path, 'utf8'),
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(nonEmptyString)) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  const result = [...new Set(value as string[])].sort();
  if (result.length !== value.length) {
    throw new Error(`${field} must not contain duplicates.`);
  }
  return result;
}

function parseProfile(value: unknown, field: string): CompileProfile {
  if (
    !record(value)
    || !nonEmptyString(value.name)
    || !nonEmptyString(value.platform)
    || !nonEmptyString(value.graphicsApi)
    || !nonEmptyString(value.capability)
  ) {
    throw new Error(`${field} is invalid.`);
  }
  return {
    name: value.name,
    platform: value.platform,
    graphicsApi: value.graphicsApi,
    capability: value.capability,
  };
}

function parseWarningPolicy(value: unknown, field: string): CompilerWarningPolicy {
  if (!record(value)) throw new Error(`${field} is required.`);
  return {
    forbiddenMessageSubstrings: stringArray(
      value.forbiddenMessageSubstrings,
      `${field}.forbiddenMessageSubstrings`,
    ),
    baseline: stringArray(value.baseline, `${field}.baseline`),
  };
}

export function parseShaderCompileContract(value: unknown): ShaderCompileContract {
  if (!record(value) || value.schemaVersion !== 1) {
    throw new Error('Shader compile contract schemaVersion must be 1.');
  }
  if (
    !record(value.policy)
    || (value.policy.unverified !== 'fail' && value.policy.unverified !== 'allow')
  ) {
    throw new Error("policy.unverified must be 'fail' or 'allow'.");
  }
  const requiredCapabilities = stringArray(
    value.requiredCapabilities,
    'requiredCapabilities',
  );
  if (requiredCapabilities.length === 0) {
    throw new Error('requiredCapabilities must not be empty.');
  }
  if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
    throw new Error('scopes must be a non-empty array.');
  }
  const ids = new Set<string>();
  const scopes = value.scopes.map((rawScope, scopeIndex): ShaderCompileScopeContract => {
    const field = `scopes[${scopeIndex}]`;
    if (
      !record(rawScope)
      || !nonEmptyString(rawScope.id)
      || !nonEmptyString(rawScope.source)
      || (rawScope.srpBatcher !== 'required' && rawScope.srpBatcher !== 'ignore')
      || !Array.isArray(rawScope.profiles)
      || rawScope.profiles.length === 0
    ) {
      throw new Error(`${field} is invalid.`);
    }
    if (ids.has(rawScope.id)) throw new Error(`Duplicate scope id '${rawScope.id}'.`);
    ids.add(rawScope.id);
    const profileKeys = new Set<string>();
    const profiles = rawScope.profiles.map((rawProfile, profileIndex) => {
      const profileField = `${field}.profiles[${profileIndex}]`;
      if (!record(rawProfile) || !nonEmptyString(rawProfile.evidence)) {
        throw new Error(`${profileField} is invalid.`);
      }
      const profile = parseProfile(rawProfile.profile, `${profileField}.profile`);
      const key = profileKey(profile);
      if (profileKeys.has(key)) {
        throw new Error(`Duplicate profile '${profile.name}' in scope '${rawScope.id}'.`);
      }
      profileKeys.add(key);
      return {
        profile,
        evidence: rawProfile.evidence,
        warnings: parseWarningPolicy(
          rawProfile.warnings,
          `${profileField}.warnings`,
        ),
      };
    });
    return {
      id: rawScope.id,
      source: rawScope.source,
      srpBatcher: rawScope.srpBatcher,
      profiles,
    };
  });
  if (!nonEmptyString(value.variantBudgets)) {
    throw new Error('variantBudgets must name a budget contract.');
  }
  return {
    schemaVersion: 1,
    policy: { unverified: value.policy.unverified },
    requiredCapabilities,
    scopes,
    variantBudgets: value.variantBudgets,
  };
}

function profileKey(profile: CompileProfile): string {
  return JSON.stringify([
    profile.name,
    profile.platform,
    profile.graphicsApi,
    profile.capability,
  ]);
}

function sameProfile(left: CompileProfile, right: CompileProfile): boolean {
  return profileKey(left) === profileKey(right);
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableFile(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return `<absolute>/${normalized.split('/').at(-1)}`;
  }
  return normalized;
}

function diagnosticSummary(message: ShaderMessage): CompilerDiagnosticSummary {
  const file = message.file === undefined ? undefined : stableFile(message.file);
  const fingerprint = JSON.stringify([
    message.message,
    file ?? null,
    message.line ?? null,
    message.platform ?? null,
  ]);
  return {
    fingerprint,
    message: message.message,
    ...(file !== undefined ? { file } : {}),
    ...(message.line !== undefined ? { line: message.line } : {}),
  };
}

function validShaderMessage(value: unknown): value is ShaderMessage {
  if (
    !record(value)
    || !nonEmptyString(value.message)
    || (value.severity !== 'warning' && value.severity !== 'error')
    || (value.messageDetails !== undefined && typeof value.messageDetails !== 'string')
    || (value.file !== undefined && !nonEmptyString(value.file))
    || (
      value.line !== undefined
      && (!Number.isSafeInteger(value.line) || (value.line as number) < 1)
    )
    || (value.platform !== undefined && !nonEmptyString(value.platform))
  ) return false;
  return true;
}

function parseProvenance(value: unknown): AdapterDiagnosticProvenance | undefined {
  if (
    !record(value)
    || value.capability !== SHADER_MESSAGES_CAPABILITY
    || !nonEmptyString(value.adapterVersion)
    || !nonEmptyString(value.unityVersion)
    || !nonEmptyString(value.projectId)
    || !nonEmptyString(value.instanceId)
    || typeof value.collectedAt !== 'number'
    || !Number.isFinite(value.collectedAt)
    || !record(value.sourceRevision)
    || !nonEmptyString(value.sourceRevision.uri)
    || !nonEmptyString(value.sourceRevision.assetGuid)
    || !/^[a-f0-9]{64}$/.test(String(value.sourceRevision.contentHash))
  ) return undefined;
  return value as unknown as AdapterDiagnosticProvenance;
}

function parseEvidence(value: unknown):
  | CapturedCompileEvidence
  | CapturedUnavailableEvidence
  | { readonly invalid: string } {
  if (!record(value) || value.schemaVersion !== 1) {
    return { invalid: 'schemaVersion must be 1' };
  }
  if (value.status === 'unavailable') {
    return nonEmptyString(value.reason)
      ? { schemaVersion: 1, status: 'unavailable', reason: value.reason }
      : { invalid: 'unavailable evidence requires a reason' };
  }
  if (value.status !== 'completed') return { invalid: 'status is invalid' };
  let profile: CompileProfile;
  try {
    profile = parseProfile(value.profile, 'evidence.profile');
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : 'profile is invalid' };
  }
  const provenance = parseProvenance(value.provenance);
  if (
    !provenance
    || !Array.isArray(value.supportedFeatures)
    || !value.supportedFeatures.every(nonEmptyString)
    || typeof value.durationMs !== 'number'
    || !Number.isFinite(value.durationMs)
    || value.durationMs < 0
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every(validShaderMessage)
  ) {
    return { invalid: 'completed evidence has invalid fields' };
  }
  return {
    schemaVersion: 1,
    status: 'completed',
    supportedFeatures: [...new Set(value.supportedFeatures as string[])].sort(),
    profile,
    durationMs: value.durationMs,
    provenance,
    diagnostics: value.diagnostics,
  };
}

function statusOf(checks: readonly VerificationStatus[]): VerificationStatus {
  if (checks.includes('failed')) return 'failed';
  if (checks.includes('unverified')) return 'unverified';
  return 'pass';
}

function unverifiedProfile(
  profile: CompileProfile,
  reason: string,
): CompileProfileCheck {
  return {
    status: 'unverified',
    profile,
    reason,
    warnings: [],
    errors: [],
    newWarnings: [],
    resolvedWarnings: [],
    violations: [],
  };
}

function stableReadError(error: unknown, absolutePath: string, label: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(absolutePath, label)
    .replaceAll(absolutePath.replace(/\//g, '\\'), label);
}

async function evaluateProfile(input: {
  readonly contract: ShaderCompileProfileContract;
  readonly requiredCapabilities: readonly string[];
  readonly sourceText: string;
  readonly evidencePath: string;
  readonly io: ShaderCompileIo;
}): Promise<CompileProfileCheck> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await input.io.readText(input.evidencePath));
  } catch (error) {
    return unverifiedProfile(
      input.contract.profile,
      `compile evidence cannot be read: ${
        stableReadError(error, input.evidencePath, input.contract.evidence)
      }`,
    );
  }
  const evidence = parseEvidence(parsed);
  if ('invalid' in evidence) {
    return unverifiedProfile(
      input.contract.profile,
      `compile evidence is invalid: ${evidence.invalid}`,
    );
  }
  if (evidence.status === 'unavailable') {
    return unverifiedProfile(input.contract.profile, evidence.reason);
  }
  if (!sameProfile(evidence.profile, input.contract.profile)) {
    return unverifiedProfile(input.contract.profile, 'compile evidence profile does not match');
  }
  if (evidence.provenance.sourceRevision.contentHash !== hash(input.sourceText)) {
    return unverifiedProfile(
      input.contract.profile,
      'compile evidence source hash does not match current Shader source',
    );
  }
  const required = new Set([
    SHADER_MESSAGES_CAPABILITY,
    ...input.requiredCapabilities,
    input.contract.profile.capability,
  ]);
  const missing = [...required]
    .filter((capability) => !evidence.supportedFeatures.includes(capability))
    .sort();
  if (missing.length > 0) {
    return unverifiedProfile(
      input.contract.profile,
      `compile evidence is missing capabilities: ${missing.join(', ')}`,
    );
  }
  const warnings = evidence.diagnostics
    .filter(({ severity }) => severity === 'warning')
    .map(diagnosticSummary)
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const errors = evidence.diagnostics
    .filter(({ severity }) => severity === 'error')
    .map(diagnosticSummary)
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const current = new Set(warnings.map(({ fingerprint }) => fingerprint));
  const baseline = new Set(input.contract.warnings.baseline);
  const newWarnings = [...current].filter((entry) => !baseline.has(entry)).sort();
  const resolvedWarnings = [...baseline].filter((entry) => !current.has(entry)).sort();
  const violations = [
    ...(errors.length > 0 ? [`${errors.length} compiler error(s)`] : []),
    ...(newWarnings.length > 0 ? [`${newWarnings.length} new compiler warning(s)`] : []),
    ...warnings.flatMap((warning) => (
      input.contract.warnings.forbiddenMessageSubstrings
        .filter((pattern) => warning.message.includes(pattern))
        .map((pattern) => (
          `forbidden compiler warning contains '${pattern}': ${warning.message}`
        ))
    )),
  ];
  return {
    status: violations.length > 0 ? 'failed' : 'pass',
    profile: input.contract.profile,
    durationMs: evidence.durationMs,
    warnings,
    errors,
    newWarnings,
    resolvedWarnings,
    violations,
  };
}

async function evaluateSrpBatcher(
  sourcePath: string,
  sourceText: string,
  requirement: ShaderCompileScopeContract['srpBatcher'],
): Promise<SrpBatcherCheck> {
  if (requirement === 'ignore') return { status: 'pass', diagnostics: [] };
  const index = await indexFile(
    pathToFileURL(sourcePath).href,
    sourceText,
    new MacroPatternRecognizer([]),
  );
  const facts = index.shaderLabMaterial;
  if (!facts?.srpEvidence) {
    return {
      status: 'unverified',
      reason: 'the selected Shader has no locally provable SRP ownership',
      diagnostics: [],
    };
  }
  const diagnostics = srpBatcherDiagnostics(index).map((diagnostic: Diagnostic) => ({
    code: String(diagnostic.code ?? 'srp-batcher'),
    message: diagnostic.message,
    line: diagnostic.range.start.line + 1,
  })).sort((left, right) => (
    left.line - right.line
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  ));
  if (diagnostics.length > 0) {
    return { status: 'failed', diagnostics };
  }
  if (
    facts.subShaderCount !== 1
    || facts.hasIncludes
    || facts.programBlocks.some(({ unterminated }) => unterminated)
    || facts.cbuffers.some(({ complete, conditional, opaque }) => (
      !complete || conditional || opaque
    ))
  ) {
    return {
      status: 'unverified',
      reason: 'the local UnityPerMaterial inventory is not exact',
      diagnostics: [],
    };
  }
  return { status: 'pass', diagnostics: [] };
}

function unavailableSrp(reason: string): SrpBatcherCheck {
  return { status: 'unverified', reason, diagnostics: [] };
}

export async function evaluateShaderCompileContract(
  contract: ShaderCompileContract,
  contractDirectory: string,
  io: ShaderCompileIo = defaultIo,
): Promise<ShaderCompileReport> {
  const scopes: ShaderCompileScopeCheck[] = [];
  for (const scope of contract.scopes) {
    const sourcePath = resolve(contractDirectory, scope.source);
    let sourceText: string;
    try {
      sourceText = await io.readText(sourcePath);
    } catch (error) {
      const reason = `Shader source cannot be read: ${
        stableReadError(error, sourcePath, scope.source)
      }`;
      const srpBatcher = unavailableSrp(reason);
      const profiles = scope.profiles.map(({ profile }) => (
        unverifiedProfile(profile, reason)
      ));
      scopes.push({
        id: scope.id,
        source: scope.source,
        status: 'unverified',
        srpBatcher,
        profiles,
      });
      continue;
    }
    const srpBatcher = await evaluateSrpBatcher(
      sourcePath,
      sourceText,
      scope.srpBatcher,
    );
    const profiles: CompileProfileCheck[] = [];
    for (const profile of scope.profiles) {
      profiles.push(await evaluateProfile({
        contract: profile,
        requiredCapabilities: contract.requiredCapabilities,
        sourceText,
        evidencePath: resolve(contractDirectory, profile.evidence),
        io,
      }));
    }
    scopes.push({
      id: scope.id,
      source: scope.source,
      status: statusOf([
        srpBatcher.status,
        ...profiles.map(({ status }) => status),
      ]),
      srpBatcher,
      profiles,
    });
  }

  const budgetPath = resolve(contractDirectory, contract.variantBudgets);
  let budgetContract: ShaderBudgetContract;
  let budgetReport: ShaderBudgetReport;
  let budgetReason: string | undefined;
  try {
    budgetContract = parseShaderBudgetContract(
      JSON.parse(await io.readText(budgetPath)),
    );
    budgetReport = await evaluateShaderBudgets(
      budgetContract,
      dirname(budgetPath),
      io,
    );
  } catch (error) {
    budgetReason = stableReadError(
      error,
      budgetPath,
      contract.variantBudgets,
    );
    budgetReport = {
      schemaVersion: 1,
      status: 'unverified',
      summary: { total: 0, passed: 0, failed: 0, unverified: 0 },
      budgets: [],
    };
  }
  const componentStatuses = [
    ...scopes.flatMap((scope) => [
      scope.srpBatcher.status,
      ...scope.profiles.map(({ status }) => status),
    ]),
    budgetReport.status,
  ];
  const summary = {
    passed: componentStatuses.filter((status) => status === 'pass').length,
    failed: componentStatuses.filter((status) => status === 'failed').length,
    unverified: componentStatuses.filter((status) => status === 'unverified').length,
  };
  return {
    schemaVersion: 1,
    status: statusOf(componentStatuses),
    policy: contract.policy,
    summary,
    scopes,
    variantBudgets: {
      contract: contract.variantBudgets,
      report: budgetReport,
      ...(budgetReason ? { reason: budgetReason } : {}),
    },
  };
}

export function contractWithCurrentWarningBaselines(
  contract: ShaderCompileContract,
  report: ShaderCompileReport,
): ShaderCompileContract {
  const scopes = new Map(report.scopes.map((scope) => [scope.id, scope]));
  return {
    ...contract,
    scopes: contract.scopes.map((scope) => {
      const result = scopes.get(scope.id);
      return {
        ...scope,
        profiles: scope.profiles.map((profile) => {
          const check = result?.profiles.find((candidate) => (
            sameProfile(candidate.profile, profile.profile)
          ));
          if (!check || check.status === 'unverified') {
            throw new Error(
              `Cannot write warning baseline for '${scope.id}/${profile.profile.name}': `
              + 'compile evidence is unverified.',
            );
          }
          return {
            ...profile,
            warnings: {
              ...profile.warnings,
              baseline: check.warnings.map(({ fingerprint }) => fingerprint).sort(),
            },
          };
        }),
      };
    }),
  };
}

function profileLabel(profile: CompileProfile): string {
  return `${profile.name} (${profile.platform}/${profile.graphicsApi})`;
}

export function formatShaderCompileReport(report: ShaderCompileReport): string {
  const lines = [
    `Shader compile contract: ${report.status.toUpperCase()} `
      + `(${report.summary.passed} passed, ${report.summary.failed} failed, `
      + `${report.summary.unverified} unverified; unverified policy: `
      + `${report.policy.unverified})`,
  ];
  for (const scope of report.scopes) {
    lines.push(`[${scope.status.toUpperCase()}] ${scope.id} — ${scope.source}`);
    lines.push(
      `  [${scope.srpBatcher.status.toUpperCase()}] SRP Batcher`
      + (scope.srpBatcher.reason ? ` — ${scope.srpBatcher.reason}` : ''),
    );
    for (const diagnostic of scope.srpBatcher.diagnostics) {
      lines.push(
        `    ${diagnostic.code} at line ${diagnostic.line}: ${diagnostic.message}`,
      );
    }
    for (const profile of scope.profiles) {
      lines.push(
        `  [${profile.status.toUpperCase()}] ${profileLabel(profile.profile)}`
        + (profile.durationMs !== undefined ? ` — ${profile.durationMs} ms` : '')
        + (profile.reason ? ` — ${profile.reason}` : ''),
      );
      for (const violation of profile.violations) {
        lines.push(`    violation: ${violation}`);
      }
      for (const warning of profile.warnings) {
        lines.push(`    warning: ${warning.message}`);
      }
      for (const error of profile.errors) {
        lines.push(`    error: ${error.message}`);
      }
    }
  }
  const budgets = report.variantBudgets.report;
  lines.push(
    `[${budgets.status.toUpperCase()}] Variant budgets — `
    + `${report.variantBudgets.contract} (${budgets.summary.passed} passed, `
    + `${budgets.summary.failed} failed, ${budgets.summary.unverified} unverified)`
    + (report.variantBudgets.reason ? ` — ${report.variantBudgets.reason}` : ''),
  );
  return lines.join('\n');
}

export function shaderCompileExitCode(report: ShaderCompileReport): 0 | 1 | 2 {
  if (report.status === 'failed') return 1;
  if (report.status === 'unverified' && report.policy.unverified === 'fail') return 2;
  return 0;
}
