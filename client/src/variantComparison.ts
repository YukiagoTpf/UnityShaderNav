import {
  commands,
  type Disposable,
  type QuickPickItem,
  window,
} from 'vscode';
import {
  SHOW_VARIANT_COMPARISON_COMMAND,
  VARIANT_COMPARISON_REQUEST,
  type CompileCandidateVariantEvidence,
  type DeclaredVariantEvidence,
  type KeptVariantEvidence,
  type VariantComparisonContext,
  type VariantComparisonParams,
  type VariantComparisonReport,
  type VariantKeywordSetIdentity,
} from '@unity-shader-nav/shared';
import type { LanguageClient } from 'vscode-languageclient/node';

export function createVariantComparisonCommand(
  client: LanguageClient,
  reportError: (message: string, error: unknown) => void,
): Disposable {
  return commands.registerCommand(SHOW_VARIANT_COMPARISON_COMMAND, async () => {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'shaderlab') {
      await window.showInformationMessage(
        'Open a saved ShaderLab asset to compare declared and Unity build Variants.',
      );
      return;
    }

    try {
      const report = await client.sendRequest<VariantComparisonReport | null>(
        VARIANT_COMPARISON_REQUEST,
        {
          textDocument: { uri: editor.document.uri.toString() },
        } satisfies VariantComparisonParams,
      );
      if (!report) {
        await window.showInformationMessage(
          'Variant comparison is unavailable because the document is not open in the language server.',
        );
        return;
      }
      await window.showQuickPick(variantComparisonItems(report), {
        title: 'UnityShaderNav Variant Comparison',
        placeHolder: 'Declared/static estimates and Unity build measurements remain separate',
        matchOnDescription: true,
        matchOnDetail: true,
      });
    } catch (error) {
      reportError('Failed to load Variant comparison', error);
    }
  });
}

export function variantComparisonItems(
  report: VariantComparisonReport,
): QuickPickItem[] {
  const items: QuickPickItem[] = [buildSummaryItem(report)];
  for (const gap of report.largestDeclaredToKeptGaps) {
    items.push({
      label: `$(diff) Declared-to-kept gap ${gap.gap}: ${keywordSetLabel(gap.keywordSet)}`,
      description: `Declared/static set ${gap.declaredCount} → Kept/measured ${gap.keptCount}`,
      detail: contextLabel(gap.context),
    });
  }
  for (const comparison of report.comparisons) {
    const largest = comparison.keywordSets.find(({ declaredToKeptGap }) => (
      declaredToKeptGap !== undefined && BigInt(declaredToKeptGap) > 0n
    ));
    items.push({
      label: `$(symbol-enum) ${contextLabel(comparison.context)}`,
      description: [
        countLabel(comparison.declared),
        countLabel(comparison.compileCandidates),
        countLabel(comparison.kept),
      ].join(' | '),
      detail: largest
        ? `Largest keyword-set gap ${largest.declaredToKeptGap}: ${keywordSetLabel(largest.identity)}`
        : 'Keyword-set gap unavailable for this Context',
    });
  }
  return items;
}

function buildSummaryItem(report: VariantComparisonReport): QuickPickItem {
  if (report.build.availability === 'unavailable') {
    return {
      label: '$(warning) Unity build evidence unavailable',
      description: report.build.reason,
      detail: 'Declared/static estimates below are not Unity build measurements.',
    };
  }
  const { provenance } = report.build;
  const failure = report.build.failure
    ? ` · ${report.build.failure.phase}: ${report.build.failure.message}`
    : '';
  return {
    label: `$(tools) Unity build evidence: ${report.build.status}`,
    description: `${provenance.buildTarget} · Unity ${provenance.unityVersion}`,
    detail: [
      `Project ${provenance.projectId}`,
      `collected ${new Date(provenance.collectedAt).toISOString()}`,
      `source ${provenance.sourceRevision.assetGuid}`,
    ].join(' · ') + failure,
  };
}

function contextLabel(context: VariantComparisonContext): string {
  const pass = context.passName
    ?? (context.passIndex !== undefined ? `Pass ${context.passIndex}` : 'Shader program');
  return [
    context.shaderName,
    pass,
    context.stage,
    context.buildTarget,
    context.graphicsApi,
  ].join(' · ');
}

function keywordSetLabel(keywordSet: VariantKeywordSetIdentity): string {
  const options = [
    ...(keywordSet.hasBlankOption ? ['<blank>'] : []),
    ...keywordSet.keywords,
  ];
  return `${options.join(' / ')} (${keywordSet.scope}${keywordSet.stage ? `/${keywordSet.stage}` : ''})`;
}

function countLabel(
  evidence: DeclaredVariantEvidence
    | CompileCandidateVariantEvidence
    | KeptVariantEvidence,
): string {
  const label = evidence.evidenceClass === 'declared'
    ? 'Declared/static upper bound'
    : evidence.evidenceClass === 'compile-candidates'
      ? 'Compile candidates/measured'
      : 'Kept/measured';
  return evidence.availability === 'available'
    ? `${label} ${evidence.count}`
    : `${label} unavailable (${evidence.reason})`;
}
