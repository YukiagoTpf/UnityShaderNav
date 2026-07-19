import type {
  AdapterDiagnosticProvenance,
  CompileProfile,
  Range,
  ShaderMessage,
  ShaderStage,
} from '@unity-shader-nav/shared';
import type {
  CancellationToken,
  Diagnostic,
  DiagnosticRelatedInformation,
  Location,
} from 'vscode-languageserver/node';
import {
  awaitWithRequestCancellation,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';

export const MAX_AGGREGATED_DIAGNOSTIC_CONTEXTS = 64;
const CONTEXT_ANALYSIS_YIELD_INTERVAL = 8;

export type DiagnosticContextDimension<T, TFacts = never> =
  | { readonly status: 'verified'; readonly value: T }
  | {
      readonly status: 'unverified';
      readonly reason: string;
      readonly facts?: TFacts;
    };

export interface DiagnosticShaderContext {
  readonly id: string;
  readonly shader: DiagnosticContextDimension<{
    readonly uri: string;
    readonly name?: string;
  }>;
  readonly pass: DiagnosticContextDimension<{
    readonly subShaderIndex: number;
    readonly passIndex?: number;
    readonly passName?: string;
  }>;
  readonly stage: DiagnosticContextDimension<{
    readonly stage: ShaderStage;
    readonly entryPoint: string;
  }>;
  readonly includePoint: DiagnosticContextDimension<{
    readonly location: { readonly uri: string; readonly range: Range };
    readonly chainDepth: number;
  }>;
  readonly keywords: DiagnosticContextDimension<{
    readonly active: readonly string[];
    readonly declared: readonly string[];
  }, {
    readonly active?: readonly string[];
    readonly declared?: readonly string[];
  }>;
  readonly platform: DiagnosticContextDimension<string>;
  readonly graphicsApi: DiagnosticContextDimension<string>;
  readonly profile?: DiagnosticContextDimension<CompileProfile>;
}

export interface StaticDiagnosticProvenance {
  readonly kind: 'static';
  readonly source: string;
  readonly revision: number;
  readonly publicationId: string;
}

export interface CompilerDiagnosticProvenance {
  readonly kind: 'compiler';
  readonly profile: CompileProfile;
  readonly shaderMessage: ShaderMessage;
  /** The complete Adapter envelope required by ADR-0008. */
  readonly envelope: AdapterDiagnosticProvenance;
}

export type ContextDiagnosticProvenance =
  | StaticDiagnosticProvenance
  | CompilerDiagnosticProvenance;

export interface ContextDiagnosticFinding {
  readonly diagnostic: Diagnostic;
  readonly provenance: ContextDiagnosticProvenance;
}

export type ContextDiagnosticAnalysis =
  | {
      readonly status: 'analyzed';
      readonly context: DiagnosticShaderContext;
      readonly findings: readonly ContextDiagnosticFinding[];
    }
  | {
      readonly status: 'unverified';
      readonly context: DiagnosticShaderContext;
      readonly reason: string;
    };

export interface BoundedContextDiagnosticAnalysis {
  readonly analyses: readonly ContextDiagnosticAnalysis[];
  readonly knownContextCount: number;
  readonly omittedContextCount: number;
}

export interface AggregatedAffectedContext {
  readonly context: DiagnosticShaderContext;
  readonly provenances: readonly ContextDiagnosticProvenance[];
}

export interface AggregatedUnverifiedContext {
  readonly context: DiagnosticShaderContext;
  readonly reason: string;
}

export interface AggregatedContextDiagnosticData {
  readonly kind: 'context-diagnostic-group';
  readonly identity: string;
  readonly affectedContextCount: number;
  readonly analyzedContextCount: number;
  readonly knownContextCount: number;
  readonly unverifiedContextCount: number;
  readonly omittedContextCount: number;
  readonly affectedContexts: readonly AggregatedAffectedContext[];
  readonly unverifiedContexts: readonly AggregatedUnverifiedContext[];
}

interface MutableAffectedContext {
  readonly context: DiagnosticShaderContext;
  readonly provenances: Map<string, ContextDiagnosticProvenance>;
  readonly fallbackLocation: Location;
}

interface MutableDiagnosticGroup {
  readonly representative: Diagnostic;
  readonly sources: Set<string>;
  readonly affectedContexts: Map<string, MutableAffectedContext>;
}

export interface AggregateContextDiagnosticsInput {
  readonly uri: string;
  readonly analyses: readonly ContextDiagnosticAnalysis[];
  readonly knownContextCount: number;
  readonly omittedContextCount: number;
}

export interface AnalyzeKnownDiagnosticContextsInput<TContext> {
  readonly contexts: readonly TContext[];
  readonly contextFacts: (context: TContext) => DiagnosticShaderContext;
  readonly analyze: (
    context: TContext,
  ) => ContextDiagnosticAnalysis | PromiseLike<ContextDiagnosticAnalysis>;
  readonly maxContexts?: number;
  readonly cancellation?: CancellationToken;
}

/**
 * Run an explicitly capped context set in deterministic order. Contexts beyond
 * the cap stay counted as omitted/unverified; they are never inferred to pass.
 */
export async function analyzeKnownDiagnosticContexts<TContext>(
  input: AnalyzeKnownDiagnosticContextsInput<TContext>,
): Promise<BoundedContextDiagnosticAnalysis> {
  const maximum = Math.max(
    0,
    Math.trunc(input.maxContexts ?? MAX_AGGREGATED_DIAGNOSTIC_CONTEXTS),
  );
  const selected = input.contexts.slice(0, maximum);
  const analyses: ContextDiagnosticAnalysis[] = [];
  for (let index = 0; index < selected.length; index++) {
    throwIfRequestCancelled(input.cancellation);
    if (
      input.cancellation
      && index > 0
      && index % CONTEXT_ANALYSIS_YIELD_INTERVAL === 0
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfRequestCancelled(input.cancellation);
    }
    const analysis = await awaitWithRequestCancellation(
      Promise.resolve(input.analyze(selected[index])),
      input.cancellation,
    );
    const expected = input.contextFacts(selected[index]);
    if (analysis.context.id !== expected.id) {
      throw new Error(
        `Diagnostic analysis returned Context '${analysis.context.id}' for '${expected.id}'.`,
      );
    }
    analyses.push(analysis);
  }
  throwIfRequestCancelled(input.cancellation);
  return {
    analyses,
    knownContextCount: input.contexts.length,
    omittedContextCount: input.contexts.length - selected.length,
  };
}

/** Group equivalent findings without merging or discarding their evidence. */
export function aggregateContextDiagnostics(
  input: AggregateContextDiagnosticsInput,
): Diagnostic[] {
  const analyzed = input.analyses.filter((analysis) => analysis.status === 'analyzed');
  const unverifiedContexts = input.analyses
    .filter((analysis): analysis is Extract<ContextDiagnosticAnalysis, {
      readonly status: 'unverified';
    }> => analysis.status === 'unverified')
    .map(({ context, reason }) => ({ context, reason }));
  const groups = new Map<string, MutableDiagnosticGroup>();

  for (const analysis of analyzed) {
    for (const finding of analysis.findings) {
      const identity = diagnosticIdentity(finding.diagnostic);
      let group = groups.get(identity);
      if (!group) {
        group = {
          representative: finding.diagnostic,
          sources: new Set(),
          affectedContexts: new Map(),
        };
        groups.set(identity, group);
      }
      if (finding.diagnostic.source) group.sources.add(finding.diagnostic.source);

      let affected = group.affectedContexts.get(analysis.context.id);
      if (!affected) {
        affected = {
          context: analysis.context,
          provenances: new Map(),
          fallbackLocation: {
            uri: input.uri,
            range: finding.diagnostic.range,
          },
        };
        group.affectedContexts.set(analysis.context.id, affected);
      }
      affected.provenances.set(
        provenanceIdentity(finding.provenance),
        finding.provenance,
      );
    }
  }

  const unverifiedContextCount = unverifiedContexts.length + input.omittedContextCount;
  return [...groups.entries()].map(([identity, group]) => {
    const affectedContexts: AggregatedAffectedContext[] = [
      ...group.affectedContexts.values(),
    ].map(({ context, provenances }) => ({
      context,
      provenances: [...provenances.values()],
    }));
    const relatedInformation = [
      ...affectedRelatedInformation(group),
      ...unverifiedContexts.map((context) => (
        unverifiedRelatedInformation(context, input.uri)
      )),
      ...(group.representative.relatedInformation ?? []),
    ];
    const coverage = unverifiedContextCount > 0
      ? ` ${unverifiedContextCount} additional Context${plural(unverifiedContextCount)} unverified.`
      : '';
    const data: AggregatedContextDiagnosticData = {
      kind: 'context-diagnostic-group',
      identity,
      affectedContextCount: affectedContexts.length,
      analyzedContextCount: analyzed.length,
      knownContextCount: input.knownContextCount,
      unverifiedContextCount,
      omittedContextCount: input.omittedContextCount,
      affectedContexts,
      unverifiedContexts,
    };
    return {
      ...group.representative,
      source: aggregateSource(group.sources, group.representative.source),
      message: [
        group.representative.message,
        `Affected in ${affectedContexts.length} of ${analyzed.length} analyzed Shader Context${plural(analyzed.length)}.${coverage}`,
      ].join('\n'),
      relatedInformation,
      data,
    };
  });
}

export function diagnosticIdentity(diagnostic: Diagnostic): string {
  return JSON.stringify({
    range: diagnostic.range,
    severity: diagnostic.severity ?? null,
    code: diagnostic.code ?? null,
    codeDescription: diagnostic.codeDescription?.href ?? null,
    message: diagnostic.message,
    tags: diagnostic.tags ?? [],
  });
}

function provenanceIdentity(provenance: ContextDiagnosticProvenance): string {
  return JSON.stringify(provenance);
}

function aggregateSource(sources: ReadonlySet<string>, fallback: string | undefined): string {
  if (sources.size <= 1) return [...sources][0] ?? fallback ?? 'UnityShaderNav';
  if ([...sources].every((source) => source.startsWith('Unity Shader Compiler ['))) {
    return 'Unity Shader Compiler (aggregated)';
  }
  return 'UnityShaderNav diagnostics';
}

function affectedRelatedInformation(
  group: MutableDiagnosticGroup,
): DiagnosticRelatedInformation[] {
  return [...group.affectedContexts.values()].flatMap((affected) => (
    [...affected.provenances.values()].map((provenance) => ({
      location: contextLocation(affected.context, affected.fallbackLocation),
      message: `Affected · ${contextLabel(affected.context)} · ${provenanceLabel(provenance)}`,
    }))
  ));
}

function unverifiedRelatedInformation(
  unverified: AggregatedUnverifiedContext,
  fallbackUri: string,
): DiagnosticRelatedInformation {
  const fallback = unverified.context.shader.status === 'verified'
    ? { uri: unverified.context.shader.value.uri, range: zeroRange() }
    : { uri: fallbackUri, range: zeroRange() };
  return {
    location: contextLocation(unverified.context, fallback),
    message: `Unverified · ${contextLabel(unverified.context)} · ${unverified.reason}`,
  };
}

function contextLocation(context: DiagnosticShaderContext, fallback: Location): Location {
  return context.includePoint.status === 'verified'
    ? context.includePoint.value.location
    : fallback;
}

function contextLabel(context: DiagnosticShaderContext): string {
  const facts: string[] = [];
  if (context.shader.status === 'verified') {
    facts.push(`Shader ${context.shader.value.name ?? context.shader.value.uri}`);
  } else {
    facts.push(`Shader unverified (${context.shader.reason})`);
  }
  if (context.pass.status === 'verified') {
    const pass = context.pass.value;
    facts.push(
      pass.passName
        ? `SubShader ${pass.subShaderIndex}, Pass ${pass.passName}`
        : pass.passIndex !== undefined
          ? `SubShader ${pass.subShaderIndex}, Pass ${pass.passIndex}`
          : `SubShader ${pass.subShaderIndex}`,
    );
  } else {
    facts.push(`Pass unverified (${context.pass.reason})`);
  }
  if (context.stage.status === 'verified') {
    facts.push(`${context.stage.value.stage} ${context.stage.value.entryPoint}`);
  } else {
    facts.push(`Stage unverified (${context.stage.reason})`);
  }
  if (context.keywords.status === 'verified') {
    facts.push(`Keywords ${context.keywords.value.active.join(', ') || 'off'}`);
  } else {
    const declared = context.keywords.facts?.declared?.join(', ');
    facts.push(
      `Keywords unverified (${context.keywords.reason}${declared ? `; declared ${declared}` : ''})`,
    );
  }
  if (context.profile?.status === 'verified') {
    facts.push(`Profile ${context.profile.value.name}`);
  } else if (context.profile) {
    facts.push(`Profile unverified (${context.profile.reason})`);
  }
  facts.push(dimensionLabel('Platform', context.platform));
  facts.push(dimensionLabel('Graphics API', context.graphicsApi));
  return facts.join(' · ');
}

function dimensionLabel(
  name: string,
  dimension: DiagnosticContextDimension<string>,
): string {
  return dimension.status === 'verified'
    ? `${name} ${dimension.value}`
    : `${name} unverified (${dimension.reason})`;
}

function provenanceLabel(provenance: ContextDiagnosticProvenance): string {
  if (provenance.kind === 'static') {
    return `Static revision ${provenance.revision} (${provenance.source})`;
  }
  const { envelope, profile } = provenance;
  return [
    `Compiler profile ${profile.name}`,
    `Unity ${envelope.unityVersion}`,
    `Adapter ${envelope.adapterVersion}`,
    `capability ${envelope.capability}`,
  ].join(', ');
}

function zeroRange(): Range {
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}
