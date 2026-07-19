import type {
  PortabilityFinding,
  PortabilityFindingCategory,
  PortabilityReport,
} from '@unity-shader-nav/shared';

const SECTIONS: ReadonlyArray<{
  readonly category: PortabilityFindingCategory;
  readonly title: string;
}> = [
  { category: 'mechanical-change', title: 'Mechanical changes' },
  { category: 'human-rewrite', title: 'Human semantic work' },
  { category: 'unsupported-semantic', title: 'Unsupported targets or semantics' },
  { category: 'verification-requirement', title: 'Compiler verification' },
];

function markdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function targetName(report: PortabilityReport): string {
  return report.target.kind === 'render-pipeline'
    ? 'Universal Render Pipeline'
    : `${report.target.profile.name} (${report.target.profile.platform}, ${report.target.profile.graphicsApi})`;
}

function verificationSummary(report: PortabilityReport): string {
  const verification = report.compilerVerification;
  switch (verification.status) {
    case 'required':
      return 'Required — no Unity compiler result is attached to this exact report.';
    case 'passed':
      return `Passed on Unity ${verification.unityVersion}: ${verification.warningCount} warning(s), ${verification.errorCount} error(s), ${verification.durationMs} ms.`;
    case 'failed':
      return `Failed on Unity ${verification.unityVersion}: ${verification.warningCount} warning(s), ${verification.errorCount} error(s), ${verification.durationMs} ms.`;
    case 'unavailable':
      return `Unavailable: ${verification.reason}.`;
  }
}

function findingLine(finding: PortabilityFinding): string {
  const fix = finding.safeFix ? ' **Quick Fix available.**' : '';
  return `- **${markdownText(finding.title)}** \`${finding.area}\` — ${markdownText(finding.explanation)}${fix}`;
}

export function formatPortabilityReportMarkdown(report: PortabilityReport): string {
  const unity = report.environment.unityVersion ?? 'unknown';
  const pkg = report.environment.renderPipelinePackage;
  const packageEvidence = pkg
    ? `${pkg.name} ${pkg.version ?? 'unknown version'} (${pkg.source ?? 'unknown source'}, ${pkg.official ? 'official' : 'unverified source'})`
    : 'not resolved';
  const lines = [
    '# Custom Shader portability report',
    '',
    `- Source: \`${markdownText(report.uri)}\``,
    `- Target: ${markdownText(targetName(report))}`,
    `- Unity ${markdownText(unity)}`,
    `- Render-pipeline Package: ${markdownText(packageEvidence)}`,
    `- Compiler evidence: ${markdownText(verificationSummary(report))}`,
    '',
    '> This static report does not claim rendered equivalence. Mechanical edits remain subject to exact-source Unity compiler verification and visual review.',
  ];

  for (const section of SECTIONS) {
    lines.push('', `## ${section.title}`, '');
    const findings = report.findings.filter((finding) => (
      finding.category === section.category
    ));
    if (findings.length === 0) lines.push('_No findings._');
    else lines.push(...findings.map(findingLine));
  }

  lines.push(
    '',
    'Quick Fixes are exposed only for findings marked **Quick Fix available**. Re-run this report after edits and compile both exact saved revisions when equivalence matters.',
    '',
  );
  return lines.join('\n');
}
