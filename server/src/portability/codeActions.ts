import {
  CodeActionKind,
  DiagnosticSeverity,
  type CodeAction,
  type CodeActionContext,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver/node';
import type {
  PortabilityFinding,
  PortabilityReport,
} from '@unity-shader-nav/shared';

export const PORTABILITY_DIAGNOSTIC_SOURCE = 'UnityShaderNav Portability';
export const PORTABILITY_DIAGNOSTIC_CODE = 'shader-portability-mechanical';

interface PortabilityDiagnosticData {
  readonly kind: 'portability-finding';
  readonly findingId: string;
}

function mechanicalFindings(report: PortabilityReport): Array<
  PortabilityFinding & { safeFix: NonNullable<PortabilityFinding['safeFix']> }
> {
  return report.findings.filter((finding): finding is PortabilityFinding & {
    safeFix: NonNullable<PortabilityFinding['safeFix']>;
  } => finding.category === 'mechanical-change' && finding.safeFix !== undefined);
}

function diagnosticRange(
  finding: PortabilityFinding & { safeFix: NonNullable<PortabilityFinding['safeFix']> },
): Range {
  return finding.range ?? finding.safeFix.edits[0]?.range ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
}

function dataOf(diagnostic: Diagnostic): PortabilityDiagnosticData | undefined {
  const data = diagnostic.data as Partial<PortabilityDiagnosticData> | undefined;
  return data?.kind === 'portability-finding' && typeof data.findingId === 'string'
    ? { kind: data.kind, findingId: data.findingId }
    : undefined;
}

function beforeOrEqual(left: Range['start'], right: Range['start']): boolean {
  return left.line < right.line
    || (left.line === right.line && left.character <= right.character);
}

function overlaps(left: Range, right: Range): boolean {
  return beforeOrEqual(left.start, right.end) && beforeOrEqual(right.start, left.end);
}

export function portabilityDiagnostics(report: PortabilityReport): Diagnostic[] {
  return mechanicalFindings(report).map((finding) => ({
    range: diagnosticRange(finding),
    severity: DiagnosticSeverity.Hint,
    code: PORTABILITY_DIAGNOSTIC_CODE,
    source: PORTABILITY_DIAGNOSTIC_SOURCE,
    message: `${finding.title}. ${finding.explanation}`,
    data: {
      kind: 'portability-finding',
      findingId: finding.id,
    } satisfies PortabilityDiagnosticData,
  }));
}

export function portabilityCodeActions(
  report: PortabilityReport,
  uri: string,
  version: number,
  requestedRange: Range,
  context: CodeActionContext,
): CodeAction[] {
  if (context.only && !context.only.some((kind) => (
    CodeActionKind.QuickFix === kind || CodeActionKind.QuickFix.startsWith(`${kind}.`)
  ))) return [];

  const diagnosticsByFinding = new Map<string, Diagnostic[]>();
  for (const diagnostic of context.diagnostics) {
    if (
      diagnostic.source !== PORTABILITY_DIAGNOSTIC_SOURCE
      || diagnostic.code !== PORTABILITY_DIAGNOSTIC_CODE
      || !overlaps(diagnostic.range, requestedRange)
    ) continue;
    const data = dataOf(diagnostic);
    if (!data) continue;
    const current = diagnosticsByFinding.get(data.findingId) ?? [];
    current.push(diagnostic);
    diagnosticsByFinding.set(data.findingId, current);
  }

  return mechanicalFindings(report).flatMap((finding) => {
    const diagnostics = diagnosticsByFinding.get(finding.id);
    if (!diagnostics || diagnostics.length === 0) return [];
    return [{
      title: finding.safeFix.title,
      kind: CodeActionKind.QuickFix,
      isPreferred: true,
      diagnostics,
      edit: {
        documentChanges: [{
          textDocument: { uri, version },
          edits: finding.safeFix.edits.map((edit) => ({
            range: edit.range,
            newText: edit.newText,
          })),
        }],
      },
    }];
  });
}
