import { Buffer } from 'node:buffer';
import {
  COMPILER_EVIDENCE_CAPABILITY,
  GPU_CAPTURE_CORRELATION_CAPABILITY,
  MAX_PASS_EXPLANATION_ANSWER_BYTES,
  MAX_PASS_EXPLANATION_DISCLOSURES,
  MAX_PASS_EXPLANATION_EDGES,
  MAX_PASS_EXPLANATION_ID_LENGTH,
  MAX_PASS_EXPLANATION_NESTED_ITEMS,
  MAX_PASS_EXPLANATION_NODES,
  MATERIAL_CONTEXT_ADAPTER_FEATURE,
  PASS_EXPLANATION_CONTRADICTION_CODES,
  PASS_EXPLANATION_QUESTION,
  PASS_EXPLANATION_SCHEMA_VERSION,
  PASS_SELECTION_DECISION_CAPABILITY,
  PASS_SELECTION_DECISION_SCHEMA_VERSION,
  PASS_SELECTION_RATIONALE_SCHEMA_VERSION,
  sourceNameMatchesUri,
  uriIdentityKey,
  VARIANT_BUILD_EVIDENCE_CAPABILITY,
  type CompilerEvidenceProvenance,
  type CompilerSourceIdentity,
  type PassExplanationAnswer,
  type PassExplanationCitation,
  type PassExplanationContradictionCode,
  type PassExplanationEvidenceRequirement,
  type PassSelectionDecisionEdge,
  type PassSelectionObservation,
} from '@unity-shader-nav/shared';

const MAX_DISPLAY_TEXT_LENGTH = 16 * 1_024;
const MAX_URI_LENGTH = 16 * 1_024;

const EVIDENCE_REQUIREMENTS = new Set<PassExplanationEvidenceRequirement>([
  'material-context',
  'selected-program',
  'source-pass',
  'shader-context',
  'selection-decision',
  'variant',
  'context-variant-link',
  'compiler',
  'context-compiler-link',
  'generated-source',
  'compiler-generated-link',
  'generated-source-map-link',
]);

// Derived from the shared list so the client cannot reject a code the server
// is allowed to emit.
const CONTRADICTION_CODES = new Set<PassExplanationContradictionCode>(
  PASS_EXPLANATION_CONTRADICTION_CODES,
);

const CITATION_KINDS = new Set<PassExplanationCitation['kind']>([
  'source-pass',
  'material-context',
  'shader-context',
  'variant',
  'compiler',
  'generated-source',
]);

export interface PassExplanationClientSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'stale' | 'failed';
  readonly sourceUri?: string;
  readonly answer?: PassExplanationAnswer;
  readonly message?: string;
}

export type PassExplanationStaleReason =
  | 'source-changed'
  | 'material-context-changed';

/**
 * Keeps request generations client-side so a slow answer for an older editor
 * can never replace the explanation explicitly requested for the current one.
 */
export class PassExplanationClientSession {
  private generation = 0;
  private snapshotValue: PassExplanationClientSnapshot = { status: 'idle' };
  private sourceUrisValue: readonly string[] = [];

  snapshot(): PassExplanationClientSnapshot {
    return this.snapshotValue;
  }

  sourceUris(): readonly string[] {
    return this.sourceUrisValue;
  }

  begin(sourceUri: string): number {
    const generation = ++this.generation;
    this.sourceUrisValue = [sourceUri];
    this.snapshotValue = {
      status: 'loading',
      sourceUri,
      message: 'Collecting current project evidence…',
    };
    return generation;
  }

  settle(
    generation: number,
    sourceUri: string,
    answer: unknown,
  ): boolean {
    if (
      generation !== this.generation
      || this.snapshotValue.status !== 'loading'
      || this.snapshotValue.sourceUri !== sourceUri
    ) return false;
    validatePassExplanationAnswer(answer);
    this.sourceUrisValue = passExplanationSourceUris(sourceUri, answer);
    this.snapshotValue = {
      status: 'ready',
      sourceUri,
      answer,
    };
    return true;
  }

  fail(generation: number, sourceUri: string, message: string): boolean {
    if (
      generation !== this.generation
      || this.snapshotValue.status !== 'loading'
      || this.snapshotValue.sourceUri !== sourceUri
    ) return false;
    this.snapshotValue = {
      status: 'failed',
      sourceUri,
      message,
    };
    return true;
  }

  invalidate(reason: PassExplanationStaleReason): boolean {
    const { sourceUri, status } = this.snapshotValue;
    if (
      !sourceUri
      || (status !== 'loading' && status !== 'ready')
    ) return false;
    this.generation++;
    this.snapshotValue = {
      status: 'stale',
      sourceUri,
      message: reason === 'source-changed'
        ? 'The owning source changed. Run “Explain Current Pass” again to collect current evidence.'
        : 'The Unity Material Context selection changed. Run “Explain Current Pass” again to collect current evidence.',
    };
    return true;
  }

  explainFromShaderSourceOnly(message: string): void {
    this.generation++;
    this.sourceUrisValue = [];
    this.snapshotValue = {
      status: 'idle',
      message,
    };
  }
}

export function passExplanationSourceUris(
  requestUri: string,
  answer: unknown,
): readonly string[] {
  validatePassExplanationAnswer(answer);
  const uris = new Set<string>([requestUri]);
  const addRevision = (revision: { readonly uri: string }): void => {
    uris.add(revision.uri);
  };
  if (answer.causalExplanation.status === 'supported') {
    addRevision(answer.causalExplanation.decision.decision.materialRevision);
    addRevision(answer.causalExplanation.decision.decision.shaderRevision);
  }
  for (const citation of answer.citations) {
    switch (citation.kind) {
      case 'source-pass':
        uris.add(citation.source.uri);
        break;
      case 'material-context':
        addRevision(citation.material.revision);
        addRevision(citation.shader.revision);
        break;
      case 'shader-context':
        uris.add(citation.correlation.uri);
        addRevision(citation.correlation.evidence.provenance.sourceRevision);
        break;
      case 'variant':
        addRevision(citation.build.provenance.sourceRevision);
        break;
      case 'compiler':
        uris.add(citation.record.sourceUri);
        addRevision(citation.record.provenance.sourceRevision);
        break;
      case 'generated-source':
        uris.add(citation.mapping.uri);
        uris.add(citation.mapping.sourceIdentity.uri);
        addRevision(citation.mapping.provenance.evidence.sourceRevision);
        break;
    }
  }
  return [...uris];
}

export interface PassExplanationHtmlOptions {
  readonly nonce: string;
}

/**
 * Scriptless, read-only evidence ledger. All values originate outside the
 * Webview trust boundary and are escaped before interpolation.
 */
export function renderPassExplanationHtml(
  snapshot: PassExplanationClientSnapshot,
  options: PassExplanationHtmlOptions,
): string {
  const nonce = escapeHtml(options.nonce);
  const answer = snapshot.answer;
  if (answer) validatePassExplanationAnswer(answer);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src 'none'; script-src 'none'; connect-src 'none';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnityShaderNav Pass Explanation</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background:
        linear-gradient(90deg, var(--vscode-panel-border) 1px, transparent 1px) 0 0 / 28px 28px,
        linear-gradient(var(--vscode-panel-border) 1px, transparent 1px) 0 0 / 28px 28px,
        var(--vscode-editor-background);
      font: 13px/1.55 var(--vscode-font-family);
    }
    .shell { max-width: 1120px; margin: 0 auto; padding: 30px clamp(18px, 4vw, 48px) 56px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: start;
      padding: 22px 24px;
      border: 1px solid var(--vscode-panel-border);
      border-top: 4px solid var(--vscode-focusBorder);
      background: var(--vscode-editorWidget-background);
    }
    .eyebrow {
      margin: 0 0 7px;
      color: var(--vscode-descriptionForeground);
      font: 700 11px/1 var(--vscode-editor-font-family);
      letter-spacing: .15em;
      text-transform: uppercase;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 7px; font-size: clamp(20px, 3vw, 29px); line-height: 1.2; }
    h2 { margin-bottom: 8px; font-size: 15px; letter-spacing: .01em; }
    h3 { margin-bottom: 7px; font-size: 13px; }
    .question { margin: 0; color: var(--vscode-descriptionForeground); }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 3px 9px;
      border: 1px solid currentColor;
      border-radius: 999px;
      font: 700 11px/1 var(--vscode-editor-font-family);
      letter-spacing: .08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .badge.supported { color: var(--vscode-testing-iconPassed); }
    .badge.refused { color: var(--vscode-editorWarning-foreground); }
    .badge.pending { color: var(--vscode-progressBar-background); }
    .badge.stale { color: var(--vscode-editorWarning-foreground); }
    .badge.failed { color: var(--vscode-testing-iconFailed); }
    .source {
      margin: 12px 0 0;
      color: var(--vscode-descriptionForeground);
      font: 12px/1.45 var(--vscode-editor-font-family);
      overflow-wrap: anywhere;
    }
    .message, .empty {
      margin-top: 18px;
      padding: 20px 22px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .message.failed { border-left: 4px solid var(--vscode-testing-iconFailed); }
    .message.stale { border-left: 4px solid var(--vscode-editorWarning-foreground); }
    .answer-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .claim {
      min-width: 0;
      padding: 20px 22px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .claim.observation { border-top: 3px solid var(--vscode-symbolIcon-variableForeground); }
    .claim.cause.supported { border-top: 3px solid var(--vscode-testing-iconPassed); }
    .claim.cause.refused { border-top: 3px solid var(--vscode-editorWarning-foreground); }
    .claim .label {
      color: var(--vscode-descriptionForeground);
      font: 700 11px/1 var(--vscode-editor-font-family);
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .claim .statement { margin: 14px 0 0; font-size: 15px; line-height: 1.55; }
    .claim .reason { margin: 12px 0 0; color: var(--vscode-descriptionForeground); }
    section.panel {
      margin-top: 16px;
      padding: 20px 22px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .section-heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .section-heading h2 { margin: 0; }
    .muted { color: var(--vscode-descriptionForeground); }
    .disclosure-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .disclosure {
      padding: 14px 16px;
      border-left: 3px solid var(--vscode-panel-border);
      background: var(--vscode-textBlockQuote-background);
    }
    .disclosure.blocking, .disclosure.contradiction {
      border-left-color: var(--vscode-editorWarning-foreground);
    }
    .disclosure p:last-child { margin-bottom: 0; }
    .identity {
      color: var(--vscode-descriptionForeground);
      font: 12px/1.5 var(--vscode-editor-font-family);
      overflow-wrap: anywhere;
    }
    .citations { display: grid; gap: 12px; }
    article.citation {
      min-width: 0;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .citation-summary { padding: 14px 16px; }
    .citation-title {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px 16px;
    }
    .citation-title h3 { margin: 0; }
    .citation-kind {
      color: var(--vscode-descriptionForeground);
      font: 11px/1 var(--vscode-editor-font-family);
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    dl {
      display: grid;
      grid-template-columns: minmax(112px, auto) minmax(0, 1fr);
      gap: 4px 14px;
      margin: 12px 0 0;
    }
    dt { color: var(--vscode-descriptionForeground); }
    dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    code, pre { font-family: var(--vscode-editor-font-family); }
    details { border-top: 1px solid var(--vscode-panel-border); }
    summary {
      padding: 9px 16px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
    }
    pre {
      max-height: 420px;
      margin: 0;
      padding: 14px 16px;
      overflow: auto;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-textCodeBlock-background);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .execution {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 1px;
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-panel-border);
    }
    .execution div { min-width: 0; padding: 12px; background: var(--vscode-editor-background); }
    .execution dt { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .execution dd { margin-top: 4px; font: 12px/1.4 var(--vscode-editor-font-family); }
    .footnote { margin: 12px 0 0; color: var(--vscode-descriptionForeground); }
    @media (max-width: 760px) {
      header, .answer-grid, .disclosure-grid { grid-template-columns: 1fr; }
      .execution { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      header .badge { justify-self: start; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <p class="eyebrow">Deterministic evidence ledger</p>
        <h1>Pass Explanation</h1>
        <p class="question">Why was this Pass selected for the current Material Context?</p>
        ${snapshot.sourceUri
          ? `<p class="source">${escapeHtml(snapshot.sourceUri)}</p>`
          : ''}
      </div>
      ${statusBadge(snapshot)}
    </header>
    ${answer
      ? renderAnswer(answer)
      : renderNonAnswer(snapshot)}
  </div>
</body>
</html>`;
}

export function validatePassExplanationAnswer(
  value: unknown,
): asserts value is PassExplanationAnswer {
  const serialized = safeJson(value);
  if (
    Buffer.byteLength(serialized, 'utf8')
    > MAX_PASS_EXPLANATION_ANSWER_BYTES
  ) {
    throw new Error(
      `Pass explanation exceeds the ${MAX_PASS_EXPLANATION_ANSWER_BYTES}-byte client boundary.`,
    );
  }
  const answer = expectRecord(value, 'answer');
  if (answer.schemaVersion !== PASS_EXPLANATION_SCHEMA_VERSION) {
    throw new Error('Pass explanation schema version is unsupported.');
  }
  if (answer.question !== PASS_EXPLANATION_QUESTION) {
    throw new Error('Pass explanation question is unsupported.');
  }
  expectId(answer.graphId, 'answer.graphId');

  const observation = expectRecord(answer.observation, 'answer.observation');
  const observationStatus = expectString(
    observation.status,
    'answer.observation.status',
  );
  if (observationStatus === 'observed') {
    expectText(observation.statement, 'answer.observation.statement');
    expectText(observation.materialName, 'answer.observation.materialName');
    expectText(observation.shaderName, 'answer.observation.shaderName');
    validateSelectedProgram(
      observation.selectedProgram,
      'answer.observation.selectedProgram',
    );
  } else if (observationStatus === 'not-observed') {
    expectOneOf(
      observation.reason,
      [
        'material-context-missing',
        'material-context-ambiguous',
        'selected-program-unavailable',
      ],
      'answer.observation.reason',
    );
    expectText(observation.statement, 'answer.observation.statement');
  } else {
    throw new Error('Pass explanation observation status is invalid.');
  }
  const observationCitationIds = validateIdArray(
    observation.citationNodeIds,
    'answer.observation.citationNodeIds',
    MAX_PASS_EXPLANATION_NODES,
  );

  const causal = expectRecord(
    answer.causalExplanation,
    'answer.causalExplanation',
  );
  const causalStatus = expectString(
    causal.status,
    'answer.causalExplanation.status',
  );
  let supportedDecision: PassSelectionDecisionEdge | undefined;
  if (causalStatus === 'supported') {
    expectOneOf(
      causal.reason,
      ['authoritative-selection-decision'],
      'answer.causalExplanation.reason',
    );
    supportedDecision = validateSelectionDecision(
      causal.decision,
      'answer.causalExplanation.decision',
    );
  } else if (causalStatus === 'refused') {
    expectOneOf(
      causal.reason,
      ['insufficient-evidence', 'contradictory-evidence', 'invalid-evidence'],
      'answer.causalExplanation.reason',
    );
  } else {
    throw new Error('Pass explanation causal status is invalid.');
  }
  expectText(causal.statement, 'answer.causalExplanation.statement');
  const causalCitationIds = validateIdArray(
    causal.citationNodeIds,
    'answer.causalExplanation.citationNodeIds',
    MAX_PASS_EXPLANATION_NODES,
  );

  const disclosures = expectRecord(answer.disclosures, 'answer.disclosures');
  const missing = expectArray(disclosures.missing, 'answer.disclosures.missing');
  if (missing.length > MAX_PASS_EXPLANATION_DISCLOSURES) {
    throw new Error('Pass explanation contains too many missing-evidence disclosures.');
  }
  for (const [index, item] of missing.entries()) {
    const disclosure = expectRecord(item, `answer.disclosures.missing[${index}]`);
    const evidence = expectString(
      disclosure.evidence,
      `answer.disclosures.missing[${index}].evidence`,
    ) as PassExplanationEvidenceRequirement;
    if (!EVIDENCE_REQUIREMENTS.has(evidence)) {
      throw new Error(`Pass explanation missing-evidence kind "${evidence}" is invalid.`);
    }
    expectBoolean(
      disclosure.blocksCausalClaim,
      `answer.disclosures.missing[${index}].blocksCausalClaim`,
    );
    expectText(
      disclosure.detail,
      `answer.disclosures.missing[${index}].detail`,
    );
  }
  const hasBlockingMissing = missing.some((item) => (
    expectRecord(item, 'answer.disclosures.missing item')
      .blocksCausalClaim === true
  ));

  const contradictions = expectArray(
    disclosures.contradictions,
    'answer.disclosures.contradictions',
  );
  if (contradictions.length > MAX_PASS_EXPLANATION_DISCLOSURES) {
    throw new Error('Pass explanation contains too many contradiction disclosures.');
  }
  for (const [index, item] of contradictions.entries()) {
    const contradiction = expectRecord(
      item,
      `answer.disclosures.contradictions[${index}]`,
    );
    const code = expectString(
      contradiction.code,
      `answer.disclosures.contradictions[${index}].code`,
    ) as PassExplanationContradictionCode;
    if (!CONTRADICTION_CODES.has(code)) {
      throw new Error(`Pass explanation contradiction code "${code}" is invalid.`);
    }
    expectText(
      contradiction.detail,
      `answer.disclosures.contradictions[${index}].detail`,
    );
    validateIdArray(
      contradiction.nodeIds,
      `answer.disclosures.contradictions[${index}].nodeIds`,
      MAX_PASS_EXPLANATION_NODES,
    );
    validateIdArray(
      contradiction.edgeIds,
      `answer.disclosures.contradictions[${index}].edgeIds`,
      MAX_PASS_EXPLANATION_EDGES,
    );
  }
  if (
    supportedDecision
    && (
      observationStatus !== 'observed'
      || hasBlockingMissing
      || contradictions.length > 0
    )
  ) {
    throw new Error(
      'Supported causal explanation cannot contain a missing observation, blocking disclosure, or contradiction.',
    );
  }

  const citations = expectArray(answer.citations, 'answer.citations');
  if (citations.length > MAX_PASS_EXPLANATION_NODES) {
    throw new Error('Pass explanation contains too many citations.');
  }
  const validatedCitations: PassExplanationCitation[] = [];
  const citationNodeIds = new Set<string>();
  for (const [index, item] of citations.entries()) {
    validateCitation(item, `answer.citations[${index}]`);
    const citation = item as PassExplanationCitation;
    if (citationNodeIds.has(citation.nodeId)) {
      throw new Error(`Pass explanation repeats citation node "${citation.nodeId}".`);
    }
    citationNodeIds.add(citation.nodeId);
    validatedCitations.push(citation);
  }
  for (const citationId of [...observationCitationIds, ...causalCitationIds]) {
    if (!citationNodeIds.has(citationId)) {
      throw new Error(`Pass explanation references missing citation node "${citationId}".`);
    }
  }
  validateObservationCitationClosure(
    observation as unknown as PassSelectionObservation,
    observationCitationIds,
    validatedCitations,
  );
  if (supportedDecision) {
    validateDecisionCitationClosure(
      supportedDecision,
      causalCitationIds,
      validatedCitations,
    );
  }
  validateCitationJoins(
    validatedCitations,
    supportedDecision !== undefined,
    new Set(causalCitationIds),
  );

  const suggestedEdits = expectArray(
    answer.suggestedEdits,
    'answer.suggestedEdits',
  );
  if (suggestedEdits.length !== 0) {
    throw new Error('Pass explanation v1 must not contain suggested edits.');
  }

  const execution = expectRecord(answer.execution, 'answer.execution');
  expectExact(
    execution.authority,
    'deterministic-local-evidence-engine',
    'answer.execution.authority',
  );
  expectExact(execution.locality, 'local-only', 'answer.execution.locality');
  expectExact(execution.model, 'not-used', 'answer.execution.model');
  expectExact(execution.telemetry, 'none', 'answer.execution.telemetry');
  expectExact(execution.retention, 'session-only', 'answer.execution.retention');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function renderNonAnswer(snapshot: PassExplanationClientSnapshot): string {
  if (snapshot.status === 'loading') {
    return `<div class="message" role="status">
      <h2>Collecting evidence</h2>
      <p class="muted">${escapeHtml(snapshot.message ?? 'Collecting current project evidence…')}</p>
    </div>`;
  }
  if (snapshot.status === 'failed') {
    return `<div class="message failed" role="alert">
      <h2>Explanation request failed</h2>
      <p>${escapeHtml(snapshot.message ?? 'The local evidence request failed.')}</p>
    </div>`;
  }
  if (snapshot.status === 'stale') {
    return `<div class="message stale" role="status">
      <h2>Explanation is stale</h2>
      <p>${escapeHtml(
        snapshot.message
          ?? 'The evidence identity changed. Run “Explain Current Pass” again.',
      )}</p>
      <p class="muted">No background explanation request was started.</p>
    </div>`;
  }
  return `<div class="empty">
    <h2>No explanation requested</h2>
    <p class="muted">${escapeHtml(
      snapshot.message
        ?? 'Run “Explain Current Pass” from an open ShaderLab or HLSL source.',
    )}</p>
  </div>`;
}

function statusBadge(snapshot: PassExplanationClientSnapshot): string {
  if (snapshot.status === 'loading') {
    return '<span class="badge pending">Collecting</span>';
  }
  if (snapshot.status === 'failed') {
    return '<span class="badge failed">Request failed</span>';
  }
  if (snapshot.status === 'stale') {
    return '<span class="badge stale">Stale · rerun required</span>';
  }
  if (snapshot.answer?.causalExplanation.status === 'supported') {
    return '<span class="badge supported">Cause supported</span>';
  }
  if (snapshot.answer?.causalExplanation.status === 'refused') {
    return '<span class="badge refused">Cause refused</span>';
  }
  return '<span class="badge">Read only</span>';
}

function renderAnswer(answer: PassExplanationAnswer): string {
  const observation = answer.observation;
  const causal = answer.causalExplanation;
  const missing = answer.disclosures.missing;
  const contradictions = answer.disclosures.contradictions;

  return `<main>
    <div class="answer-grid">
      <section class="claim observation" aria-labelledby="observation-title">
        <span class="label">Observed project fact</span>
        <h2 id="observation-title">${observation.status === 'observed'
          ? 'Pass selection observed'
          : 'Pass selection not observed'}</h2>
        <p class="statement">${escapeHtml(observation.statement)}</p>
        <p class="reason">Status: <code>${escapeHtml(observation.status)}</code>${observation.status === 'not-observed'
          ? ` · Reason: <code>${escapeHtml(observation.reason)}</code>`
          : ''}</p>
        ${citationIdentityLine(observation.citationNodeIds)}
      </section>
      <section class="claim cause ${causal.status}" aria-labelledby="cause-title">
        <span class="label">Causal explanation</span>
        <h2 id="cause-title">${causal.status === 'supported'
          ? 'Supported by authoritative evidence'
          : 'Refused at the evidence boundary'}</h2>
        <p class="statement">${escapeHtml(causal.statement)}</p>
        <p class="reason">Reason: <code>${escapeHtml(causal.reason)}</code>${causal.status === 'supported'
          ? ` · Decision: <code>${escapeHtml(causal.decision.decision.decisionId)}</code> · Edge: <code>${escapeHtml(causal.decision.id)}</code>`
          : ''}</p>
        ${causal.status === 'supported'
          ? `<p class="identity">Selection rule: <code>${escapeHtml(causal.decision.decision.rationale.ruleId)}</code><br>Rule facts: ${causal.decision.decision.rationale.facts.map((fact) => `${escapeHtml(fact.name)}=<code>${escapeHtml(fact.value)}</code>`).join(' · ')}</p>`
          : ''}
        ${citationIdentityLine(causal.citationNodeIds)}
      </section>
    </div>

    <section class="panel" aria-labelledby="disclosures-title">
      <div class="section-heading">
        <h2 id="disclosures-title">Evidence disclosures</h2>
        <span class="muted">${missing.length} missing · ${contradictions.length} contradictory</span>
      </div>
      ${missing.length === 0 && contradictions.length === 0
        ? '<p class="muted">No missing or contradictory evidence was reported.</p>'
        : `<div class="disclosure-grid">
            ${missing.map((item) => `<article class="disclosure ${item.blocksCausalClaim ? 'blocking' : ''}">
              <h3>Missing · <code>${escapeHtml(item.evidence)}</code></h3>
              <p>${escapeHtml(item.detail)}</p>
              <p class="identity">${item.blocksCausalClaim
                ? 'Blocks the causal claim'
                : 'Optional corroboration; does not itself block the causal claim'}</p>
            </article>`).join('')}
            ${contradictions.map((item) => `<article class="disclosure contradiction">
              <h3>Contradiction · <code>${escapeHtml(item.code)}</code></h3>
              <p>${escapeHtml(item.detail)}</p>
              <p class="identity">Nodes: ${escapeHtml(item.nodeIds.join(', ') || 'none')}<br>Edges: ${escapeHtml(item.edgeIds.join(', ') || 'none')}</p>
            </article>`).join('')}
          </div>`}
    </section>

    <section class="panel" aria-labelledby="citations-title">
      <div class="section-heading">
        <h2 id="citations-title">Exact project citations</h2>
        <span class="muted">${answer.citations.length} evidence node${answer.citations.length === 1 ? '' : 's'}</span>
      </div>
      ${answer.citations.length === 0
        ? '<p class="muted">No evidence node was safe to cite.</p>'
        : `<div class="citations">${answer.citations.map(renderCitation).join('')}</div>`}
    </section>

    <section class="panel" aria-labelledby="execution-title">
      <div class="section-heading">
        <h2 id="execution-title">Execution boundary</h2>
        <span class="muted">Explanation-only · no edit controls</span>
      </div>
      <dl class="execution">
        <div><dt>Authority</dt><dd>Deterministic local evidence engine</dd></div>
        <div><dt>Locality</dt><dd>Local only</dd></div>
        <div><dt>Language model</dt><dd>Not used</dd></div>
        <div><dt>Telemetry</dt><dd>None</dd></div>
        <div><dt>Retention</dt><dd>Session only</dd></div>
      </dl>
      <p class="footnote">The panel presents the structured answer as produced. It does not resolve symbols, count Variants, establish compiler truth, or offer an edit action.</p>
    </section>
  </main>`;
}

function citationIdentityLine(ids: readonly string[]): string {
  return `<p class="identity">Citations: ${ids.length > 0
    ? ids.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')
    : 'none'}</p>`;
}

function renderCitation(citation: PassExplanationCitation): string {
  const summary = citationSummary(citation);
  return `<article class="citation" id="citation-${escapeHtml(citation.nodeId)}">
    <div class="citation-summary">
      <div class="citation-title">
        <h3><code>${escapeHtml(citation.nodeId)}</code></h3>
        <span class="citation-kind">${escapeHtml(citation.kind)}</span>
      </div>
      <dl>
        ${summary.map(([term, detail]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(detail)}</dd>`).join('')}
      </dl>
    </div>
    <details>
      <summary>Exact citation payload</summary>
      <pre>${escapeHtml(JSON.stringify(citation, null, 2))}</pre>
    </details>
  </article>`;
}

function citationSummary(
  citation: PassExplanationCitation,
): readonly (readonly [string, string])[] {
  switch (citation.kind) {
    case 'source-pass':
      return [
        ['Source', citation.source.uri],
        ['Identity', `${citation.source.sourceId} · sha256:${citation.source.contentHash}`],
        ['Range', formatRange(citation.range)],
        ['Program', formatProgram(citation.program)],
      ];
    case 'material-context':
      return [
        ['Selection', citation.selectionId],
        ['Material', `${citation.material.name} · ${citation.material.path}`],
        ['Shader', `${citation.shader.name} · ${citation.shader.path}`],
        ['Selected Pass', citation.selectedProgram
          ? formatProgram(citation.selectedProgram)
          : 'not reported'],
        ['Provenance', formatBasicProvenance(citation.provenance)],
      ];
    case 'shader-context':
      return [
        ['Context', citation.correlation.context.id],
        ['Shader', citation.correlation.context.shaderName],
        ['Program', formatProgram(citation.correlation.context)],
        ['Stage', `${citation.correlation.context.stage} · ${citation.correlation.context.entryPoint}`],
        ['Draw', `${citation.correlation.evidence.draw.captureId} · frame ${citation.correlation.evidence.draw.frameIndex} · draw ${citation.correlation.evidence.draw.drawIndex}`],
        ['Trace', citation.correlation.traceStatus],
        ['Mapping', `${citation.correlation.uri} · ${formatRange(citation.correlation.range)}`],
        ['Provenance', formatBasicProvenance(citation.correlation.evidence.provenance)],
      ];
    case 'variant':
      return [
        ['Shader', citation.context.shaderName],
        ['Program', formatProgram(citation.context)],
        ['Build', citation.build.failure
          ? `${citation.build.status} · ${citation.build.failure.phase}: ${citation.build.failure.message}`
          : citation.build.status],
        ['Target', `${citation.build.provenance.buildTarget} · ${citation.context.graphicsApi}`],
        ['Variants', `candidates ${formatMeasuredCount(citation.context.compileCandidates)} · kept ${formatMeasuredCount(citation.context.kept)}`],
        ['Provenance', formatBasicProvenance(citation.build.provenance)],
      ];
    case 'compiler':
      return [
        ['Evidence', `${citation.record.status}${citation.record.status === 'stale'
          ? ` (${citation.record.reason})`
          : ''} · ${citation.record.evidenceId}`],
        ['Context', citation.record.contextId],
        ['Profile', `${citation.record.profile.name} · ${citation.record.profile.platform} · ${citation.record.profile.graphicsApi}`],
        ['Source', formatRevision(citation.record.provenance.sourceRevision)],
        ['Views', citation.record.views.map(({ kind, uri, contentHash }) => (
          `${kind}: ${uri} · sha256:${contentHash}`
        )).join(' · ')],
        ['Provenance', formatBasicProvenance(citation.record.provenance)],
      ];
    case 'generated-source':
      return [
        ['Evidence', citation.evidenceId],
        ['Generated view', `${citation.view.kind} · ${citation.view.uri}`],
        ['Document', `sha256:${citation.document.contentHash} · ${formatRange(citation.document.range)}`],
        ['Mapped source', `${citation.mapping.uri} · ${formatRange(citation.mapping.range)}`],
        ['Source identity', `${citation.mapping.sourceIdentity.sourceId} · sha256:${citation.mapping.sourceIdentity.contentHash}`],
        ['Mapping', citation.mapping.provenance.method],
      ];
  }
}

function formatProgram(program: {
  readonly shaderName?: string;
  readonly subShaderIndex: number;
  readonly passIndex?: number;
  readonly passName?: string;
}): string {
  return [
    program.shaderName,
    `SubShader ${program.subShaderIndex}`,
    program.passIndex === undefined ? 'Pass not reported' : `Pass ${program.passIndex}`,
    program.passName,
  ].filter((value): value is string => value !== undefined && value !== '')
    .join(' · ');
}

function formatRange(range: {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}): string {
  return `${range.start.line + 1}:${range.start.character + 1}–${range.end.line + 1}:${range.end.character + 1}`;
}

function formatRevision(revision: {
  readonly uri: string;
  readonly assetGuid: string;
  readonly contentHash: string;
}): string {
  return `${revision.uri} · ${revision.assetGuid} · sha256:${revision.contentHash}`;
}

function formatMeasuredCount(count: {
  readonly availability: 'available' | 'unavailable';
  readonly count?: string;
  readonly reason?: string;
}): string {
  return count.availability === 'available'
    ? count.count ?? 'invalid'
    : `unavailable (${count.reason ?? 'unspecified'})`;
}

function formatBasicProvenance(provenance: {
  readonly capability: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  readonly collectedAt: number;
}): string {
  const collectedAt = Number.isFinite(provenance.collectedAt)
    ? new Date(provenance.collectedAt).toISOString()
    : 'invalid timestamp';
  return `${provenance.capability} · project ${provenance.projectId} · instance ${provenance.instanceId} · Adapter ${provenance.adapterVersion} · Unity ${provenance.unityVersion} · ${collectedAt}`;
}

function validateObservationCitationClosure(
  observation: PassSelectionObservation,
  citationIds: readonly string[],
  citations: readonly PassExplanationCitation[],
): void {
  const cited = citationIds.map((nodeId) => (
    citations.find((citation) => citation.nodeId === nodeId)!
  ));
  if (observation.status === 'observed') {
    const material = cited.length === 1 ? cited[0] : undefined;
    if (
      material?.kind !== 'material-context'
      || observation.materialName !== material.material.name
      || observation.shaderName !== material.shader.name
      || !sameExactProgram(
        observation.selectedProgram,
        material.selectedProgram,
      )
    ) {
      throw new Error(
        'Observed Pass identity must match exactly one Material Context citation.',
      );
    }
    return;
  }
  if (observation.reason === 'material-context-missing') {
    if (citationIds.length !== 0) {
      throw new Error(
        'A missing Material Context observation cannot cite Material evidence.',
      );
    }
    return;
  }
  if (observation.reason === 'material-context-ambiguous') {
    const everyMaterialId = citations
      .filter(({ kind }) => kind === 'material-context')
      .map(({ nodeId }) => nodeId);
    if (
      cited.length < 2
      || cited.some(({ kind }) => kind !== 'material-context')
      || everyMaterialId.length !== cited.length
      || everyMaterialId.some((nodeId) => !citationIds.includes(nodeId))
    ) {
      throw new Error(
        'An ambiguous Material Context observation must cite every competing Material.',
      );
    }
    return;
  }
  const material = cited.length === 1 ? cited[0] : undefined;
  if (
    material?.kind !== 'material-context'
    || passIsIdentified(material.selectedProgram)
  ) {
    throw new Error(
      'An unavailable selected Program must cite one Material without a Pass identity.',
    );
  }
}

function validateSelectionDecision(
  value: unknown,
  path: string,
): PassSelectionDecisionEdge {
  const edge = expectRecord(value, path);
  expectId(edge.id, `${path}.id`);
  expectExact(edge.kind, 'selection-decision', `${path}.kind`);
  expectId(edge.materialNodeId, `${path}.materialNodeId`);
  expectId(edge.contextNodeId, `${path}.contextNodeId`);
  expectId(edge.sourceNodeId, `${path}.sourceNodeId`);
  expectExact(
    edge.reason,
    'adapter-reported-material-pass-selection',
    `${path}.reason`,
  );
  const decision = expectRecord(edge.decision, `${path}.decision`);
  if (decision.schemaVersion !== PASS_SELECTION_DECISION_SCHEMA_VERSION) {
    throw new Error(`${path}.decision.schemaVersion is unsupported.`);
  }
  expectId(decision.decisionId, `${path}.decision.decisionId`);
  expectId(decision.selectionId, `${path}.decision.selectionId`);
  validateSelectedProgram(decision.program, `${path}.decision.program`);
  validateRevision(decision.materialRevision, `${path}.decision.materialRevision`);
  validateRevision(decision.shaderRevision, `${path}.decision.shaderRevision`);
  expectId(decision.contextId, `${path}.decision.contextId`);
  validateSelectionRationale(
    decision.rationale,
    `${path}.decision.rationale`,
  );
  const provenance = validateBasicProvenance(
    decision.provenance,
    `${path}.decision.provenance`,
  );
  expectExact(
    provenance.capability,
    PASS_SELECTION_DECISION_CAPABILITY,
    `${path}.decision.provenance.capability`,
  );
  return edge as unknown as PassSelectionDecisionEdge;
}

function validateSelectionRationale(value: unknown, path: string): void {
  const rationale = expectRecord(value, path);
  if (rationale.schemaVersion !== PASS_SELECTION_RATIONALE_SCHEMA_VERSION) {
    throw new Error(`${path}.schemaVersion is unsupported.`);
  }
  expectId(rationale.ruleId, `${path}.ruleId`);
  expectText(rationale.summary, `${path}.summary`);
  const facts = expectArray(rationale.facts, `${path}.facts`);
  if (
    facts.length === 0
    || facts.length > MAX_PASS_EXPLANATION_NESTED_ITEMS
  ) {
    throw new Error(`${path}.facts must be a bounded non-empty array.`);
  }
  const names = new Set<string>();
  for (const [index, value] of facts.entries()) {
    const fact = expectRecord(value, `${path}.facts[${index}]`);
    const name = expectText(fact.name, `${path}.facts[${index}].name`);
    expectText(fact.value, `${path}.facts[${index}].value`);
    if (names.has(name)) throw new Error(`${path}.facts repeats "${name}".`);
    names.add(name);
  }
}

function validateDecisionCitationClosure(
  edge: PassSelectionDecisionEdge,
  causalCitationIds: readonly string[],
  citations: readonly PassExplanationCitation[],
): void {
  const citationsById = new Map(citations.map((citation) => [
    citation.nodeId,
    citation,
  ]));
  const endpoints = [
    [edge.materialNodeId, 'material-context'],
    [edge.contextNodeId, 'shader-context'],
    [edge.sourceNodeId, 'source-pass'],
  ] as const;
  for (const [nodeId, kind] of endpoints) {
    if (!causalCitationIds.includes(nodeId)) {
      throw new Error(`Supported decision endpoint "${nodeId}" is absent from causal citations.`);
    }
    if (citationsById.get(nodeId)?.kind !== kind) {
      throw new Error(`Supported decision endpoint "${nodeId}" must cite ${kind} evidence.`);
    }
  }

  const material = citationsById.get(edge.materialNodeId);
  const context = citationsById.get(edge.contextNodeId);
  const source = citationsById.get(edge.sourceNodeId);
  if (
    material?.kind !== 'material-context'
    || context?.kind !== 'shader-context'
    || source?.kind !== 'source-pass'
  ) return;

  const decision = edge.decision;
  if (
    decision.selectionId !== material.selectionId
    || material.provenance.sourceRevision !== material.selectionId
    || !sameProgram(decision.program, material.selectedProgram)
  ) {
    throw new Error('Supported decision does not match its Material Context citation.');
  }
  if (!sameProgram(decision.program, source.program)) {
    throw new Error('Supported decision does not match its source Pass citation.');
  }
  const correlation = context.correlation;
  const sourceStage = source.program.stages.find(
    ({ stage }) => stage === correlation.context.stage,
  );
  if (
    correlation.traceStatus !== 'verified-local-trace'
    || correlation.traceVerification.status !== 'verified-local-trace'
    || correlation.evidence.mapping.status !== 'mapped'
    || decision.contextId !== correlation.context.id
    || !sameProgram(decision.program, correlation.context)
    || material.shader.name !== source.program.shaderName
    || material.shader.name !== correlation.context.shaderName
    || source.program.shaderName !== correlation.context.shaderName
    || sourceStage?.entryPoint !== correlation.context.entryPoint
  ) {
    throw new Error('Supported decision does not match its Shader Context citation.');
  }
  if (
    !sameRevisionIdentity(
      decision.materialRevision,
      material.material.revision,
    )
    || !sameRevisionIdentity(
      decision.shaderRevision,
      material.shader.revision,
    )
    || !sourceIdentityMatchesRevision(
      source.source,
      decision.shaderRevision,
    )
    || !sameRevisionIdentity(
      decision.shaderRevision,
      correlation.evidence.provenance.sourceRevision,
    )
    || correlation.evidence.mapping.sourceEntryPoint
      !== correlation.context.entryPoint
    || correlation.evidence.mapping.expectedText
      !== correlation.context.entryPoint
    || uriIdentityKey(correlation.uri) !== uriIdentityKey(source.source.uri)
    || uriIdentityKey(correlation.evidence.mapping.uri)
      !== uriIdentityKey(source.source.uri)
    || !sameRange(
      correlation.range,
      correlation.evidence.mapping.range,
    )
    || !containsRange(source.range, correlation.range)
  ) {
    throw new Error(
      'Supported decision revisions and mapped source range do not close over its endpoint citations.',
    );
  }
  for (const provenance of [
    material.provenance,
    correlation.evidence.provenance,
  ]) {
    if (!sameAdapterSession(decision.provenance, provenance)) {
      throw new Error('Supported decision provenance does not match its endpoint citations.');
    }
  }
}

function validateCurrentCorrelation(value: unknown, path: string): void {
  const correlation = expectRecord(value, path);
  expectExact(correlation.status, 'current', `${path}.status`);
  const traceStatus = expectOneOf(
    correlation.traceStatus,
    ['verified-local-trace', 'sanitized-fixture'],
    `${path}.traceStatus`,
  );
  const evidence = expectRecord(correlation.evidence, `${path}.evidence`);
  if (evidence.schemaVersion !== 1) {
    throw new Error(`${path}.evidence.schemaVersion must be 1.`);
  }
  const provenance = validateGpuCaptureProvenance(
    evidence.provenance,
    `${path}.evidence.provenance`,
  );
  const draw = validateCapturedDraw(evidence.draw, `${path}.evidence.draw`);
  validateTraceVerification(
    correlation.traceVerification,
    `${path}.traceVerification`,
    traceStatus,
    draw,
  );
  const evidenceContext = validateCapturedContext(
    evidence.context,
    `${path}.evidence.context`,
  );
  const evidenceMapping = validateGpuMapping(
    evidence.mapping,
    `${path}.evidence.mapping`,
  );
  const correlationUri = expectUri(correlation.uri, `${path}.uri`);
  validateRange(correlation.range, `${path}.range`);
  const currentContext = validateCapturedContext(
    correlation.context,
    `${path}.context`,
  );
  if (
    !sameRange(correlation.range, evidenceMapping.range)
    || !sameCapturedContext(currentContext, evidenceContext)
    || evidenceMapping.expectedText !== evidenceContext.entryPoint
    || evidenceMapping.sourceEntryPoint !== evidenceContext.entryPoint
    || !rangeMatchesExactText(
      evidenceMapping.range,
      evidenceMapping.expectedText,
    )
    || uriIdentityKey(correlationUri) !== uriIdentityKey(evidenceMapping.uri)
    || uriIdentityKey(correlationUri) !== uriIdentityKey(
      (provenance.sourceRevision as { readonly uri: string }).uri,
    )
  ) {
    throw new Error(`${path} is not a self-consistent current correlation envelope.`);
  }
}

function validateGpuCaptureProvenance(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const provenance = validateBasicProvenance(value, path);
  expectExact(
    provenance.capability,
    GPU_CAPTURE_CORRELATION_CAPABILITY,
    `${path}.capability`,
  );
  expectText(provenance.unityBinaryVersion, `${path}.unityBinaryVersion`);
  const platform = expectRecord(provenance.platform, `${path}.platform`);
  expectExact(platform.operatingSystem, 'macOS', `${path}.platform.operatingSystem`);
  expectText(platform.operatingSystemVersion, `${path}.platform.operatingSystemVersion`);
  expectExact(platform.architecture, 'arm64', `${path}.platform.architecture`);
  const gpu = expectRecord(provenance.gpu, `${path}.gpu`);
  expectText(gpu.name, `${path}.gpu.name`);
  expectText(gpu.driverVersion, `${path}.gpu.driverVersion`);
  if (gpu.registryId !== undefined) expectText(gpu.registryId, `${path}.gpu.registryId`);
  expectExact(provenance.graphicsApi, 'Metal', `${path}.graphicsApi`);
  const tool = expectRecord(provenance.tool, `${path}.tool`);
  expectExact(tool.name, 'Xcode Metal Frame Debugger', `${path}.tool.name`);
  expectText(tool.version, `${path}.tool.version`);
  expectText(tool.buildVersion, `${path}.tool.buildVersion`);
  expectText(tool.metalCompilerVersion, `${path}.tool.metalCompilerVersion`);
  expectExact(tool.traceFormat, 'gputrace', `${path}.tool.traceFormat`);
  validateRevision(provenance.sourceRevision, `${path}.sourceRevision`);
  return provenance;
}

function validateCapturedDraw(
  value: unknown,
  path: string,
): {
  readonly label: string;
  readonly trace: {
    readonly fileName: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
} {
  const draw = expectRecord(value, path);
  expectId(draw.captureId, `${path}.captureId`);
  expectNonNegativeInteger(draw.frameIndex, `${path}.frameIndex`);
  expectNonNegativeInteger(draw.drawIndex, `${path}.drawIndex`);
  const label = expectText(draw.label, `${path}.label`);
  const trace = expectRecord(draw.trace, `${path}.trace`);
  expectExact(trace.storage, 'local-ephemeral', `${path}.trace.storage`);
  const fileName = expectText(trace.fileName, `${path}.trace.fileName`);
  if (
    fileName === '.'
    || fileName === '..'
    || fileName.includes('/')
    || fileName.includes('\\')
    || !fileName.endsWith('.gputrace')
  ) {
    throw new Error(`${path}.trace.fileName must be a local .gputrace basename.`);
  }
  const sha256 = expectHash(trace.sha256, `${path}.trace.sha256`);
  const byteLength = expectPositiveSafeInteger(
    trace.byteLength,
    `${path}.trace.byteLength`,
  );
  return {
    label,
    trace: { fileName, sha256, byteLength },
  };
}

function validateTraceVerification(
  value: unknown,
  path: string,
  traceStatus: string,
  draw: {
    readonly label: string;
    readonly trace: {
      readonly fileName: string;
      readonly sha256: string;
      readonly byteLength: number;
    };
  },
): void {
  const verification = expectRecord(value, path);
  const status = expectOneOf(
    verification.status,
    ['verified-local-trace', 'sanitized-fixture'],
    `${path}.status`,
  );
  if (status !== traceStatus) {
    throw new Error(`${path}.status must match correlation.traceStatus.`);
  }
  if (status === 'sanitized-fixture') return;

  const fileName = expectText(verification.fileName, `${path}.fileName`);
  if (
    fileName === '.'
    || fileName === '..'
    || fileName.includes('/')
    || fileName.includes('\\')
    || !fileName.endsWith('.gputrace')
  ) {
    throw new Error(`${path}.fileName must be a local .gputrace basename.`);
  }
  const sha256 = expectHash(verification.sha256, `${path}.sha256`);
  const byteLength = expectPositiveSafeInteger(
    verification.byteLength,
    `${path}.byteLength`,
  );
  const labels = validateUniqueTextArray(
    verification.labels,
    `${path}.labels`,
    MAX_PASS_EXPLANATION_NESTED_ITEMS,
  );
  if (
    fileName !== draw.trace.fileName
    || sha256 !== draw.trace.sha256
    || byteLength !== draw.trace.byteLength
  ) {
    throw new Error(`${path} must exactly match the captured draw trace identity.`);
  }
  if (!labels.includes(draw.label)) {
    throw new Error(`${path}.labels must contain the captured draw label.`);
  }
}

function validateCapturedContext(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const context = expectRecord(value, path);
  expectId(context.id, `${path}.id`);
  expectText(context.shaderName, `${path}.shaderName`);
  validateSelectedProgram(context, path);
  expectNonNegativeInteger(context.passIndex, `${path}.passIndex`);
  expectOneOf(
    context.stage,
    ['vertex', 'fragment', 'geometry', 'hull', 'domain', 'surface', 'kernel', 'raytracing'],
    `${path}.stage`,
  );
  expectText(context.entryPoint, `${path}.entryPoint`);
  const keywords = expectRecord(context.keywords, `${path}.keywords`);
  validateUniqueTextArray(
    keywords.enabled,
    `${path}.keywords.enabled`,
    MAX_PASS_EXPLANATION_NESTED_ITEMS,
  );
  expectBoolean(keywords.incomplete, `${path}.keywords.incomplete`);
  return context;
}

function validateGpuMapping(
  value: unknown,
  path: string,
): {
  readonly uri: string;
  readonly range: ValidatedRange;
  readonly expectedText: string;
  readonly sourceEntryPoint: string;
} {
  const mapping = expectRecord(value, path);
  expectExact(mapping.status, 'mapped', `${path}.status`);
  expectExact(
    mapping.method,
    'adapter-exact-source-range',
    `${path}.method`,
  );
  return {
    uri: expectUri(mapping.uri, `${path}.uri`),
    range: validateRange(mapping.range, `${path}.range`),
    expectedText: expectText(mapping.expectedText, `${path}.expectedText`),
    sourceEntryPoint: expectText(
      mapping.sourceEntryPoint,
      `${path}.sourceEntryPoint`,
    ),
  };
}

function validateVariantBuild(value: unknown, path: string): void {
  const build = expectRecord(value, path);
  const status = expectOneOf(
    build.status,
    ['completed', 'incomplete', 'failed'],
    `${path}.status`,
  );
  const provenance = validateBasicProvenance(build.provenance, `${path}.provenance`);
  expectExact(
    provenance.capability,
    VARIANT_BUILD_EVIDENCE_CAPABILITY,
    `${path}.provenance.capability`,
  );
  expectText(provenance.buildTarget, `${path}.provenance.buildTarget`);
  validateRevision(provenance.sourceRevision, `${path}.provenance.sourceRevision`);
  if (build.failure !== undefined) {
    const failure = expectRecord(build.failure, `${path}.failure`);
    expectOneOf(
      failure.phase,
      ['compilation', 'stripping', 'build'],
      `${path}.failure.phase`,
    );
    expectText(failure.message, `${path}.failure.message`);
  }
  if (status === 'completed' && build.failure !== undefined) {
    throw new Error(`${path} completed build must not contain failure.`);
  }
  if (status === 'failed' && build.failure === undefined) {
    throw new Error(`${path} failed build must contain failure.`);
  }
}

function validateVariantContext(value: unknown, path: string): void {
  const context = expectRecord(value, path);
  expectText(context.shaderName, `${path}.shaderName`);
  validateProgram(context, path, true);
  expectOneOf(
    context.stage,
    ['vertex', 'fragment', 'geometry', 'hull', 'domain', 'surface', 'kernel', 'raytracing'],
    `${path}.stage`,
  );
  expectText(context.graphicsApi, `${path}.graphicsApi`);
  validateMeasuredCount(context.compileCandidates, `${path}.compileCandidates`);
  validateMeasuredCount(context.kept, `${path}.kept`);
  const keywordSets = expectArray(context.keywordSets, `${path}.keywordSets`);
  if (keywordSets.length > MAX_PASS_EXPLANATION_NESTED_ITEMS) {
    throw new Error(`${path}.keywordSets exceeds its item boundary.`);
  }
  for (const [index, value] of keywordSets.entries()) {
    const set = expectRecord(value, `${path}.keywordSets[${index}]`);
    validateUniqueTextArray(
      set.keywords,
      `${path}.keywordSets[${index}].keywords`,
      MAX_PASS_EXPLANATION_NESTED_ITEMS,
    );
    expectOneOf(set.scope, ['global', 'local'], `${path}.keywordSets[${index}].scope`);
    if (set.stage !== undefined) {
      expectOneOf(
        set.stage,
        ['vertex', 'fragment', 'geometry', 'hull', 'domain', 'surface', 'kernel', 'raytracing'],
        `${path}.keywordSets[${index}].stage`,
      );
    }
    expectBoolean(set.hasBlankOption, `${path}.keywordSets[${index}].hasBlankOption`);
    validateMeasuredCount(
      set.compileCandidates,
      `${path}.keywordSets[${index}].compileCandidates`,
    );
    validateMeasuredCount(set.kept, `${path}.keywordSets[${index}].kept`);
  }
}

function validateCompilerRecord(value: unknown, path: string): void {
  const record = expectRecord(value, path);
  const status = expectString(record.status, `${path}.status`);
  const evidenceId = expectHash(record.evidenceId, `${path}.evidenceId`);
  const sourceUri = expectUri(record.sourceUri, `${path}.sourceUri`);
  const contextId = expectId(record.contextId, `${path}.contextId`);
  const profile = validateCompileProfile(record.profile, `${path}.profile`);
  const views = expectArray(record.views, `${path}.views`);
  if (views.length === 0 || views.length > 2) {
    throw new Error(`${path}.views must contain one or two compiler views.`);
  }
  const viewKinds = new Set<string>();
  for (const [index, value] of views.entries()) {
    const view = expectRecord(value, `${path}.views[${index}]`);
    const kind = expectOneOf(
      view.kind,
      ['preprocessed', 'generated'],
      `${path}.views[${index}].kind`,
    );
    if (viewKinds.has(kind)) throw new Error(`${path}.views repeats "${kind}".`);
    viewKinds.add(kind);
    const uri = expectUri(view.uri, `${path}.views[${index}].uri`);
    if (uri !== compilerViewUri(evidenceId, kind)) {
      throw new Error(`${path}.views[${index}].uri does not bind its evidenceId.`);
    }
    expectHash(
      view.contentHash,
      `${path}.views[${index}].contentHash`,
    );
  }
  const provenance = validateCompilerProvenance(
    record.provenance,
    `${path}.provenance`,
  );
  if (
    provenance.contextId !== contextId
    || !sameProfile(profile, provenance.profile)
    || uriIdentityKey(sourceUri) !== uriIdentityKey(
      (provenance.sourceRevision as { readonly uri: string }).uri,
    )
  ) {
    throw new Error(`${path} does not match its compiler provenance.`);
  }
  if (status === 'stale') {
    expectOneOf(
      record.reason,
      ['source-changed', 'source-deleted', 'source-hash-mismatch', 'adapter-disconnected', 'adapter-reconnected', 'superseded'],
      `${path}.reason`,
    );
    return;
  }
  expectExact(status, 'current', `${path}.status`);
  if (record.reason !== undefined) {
    throw new Error(`${path} current record must not contain a stale reason.`);
  }
}

function validateCompilerProvenance(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const provenance = validateBasicProvenance(value, path);
  expectExact(
    provenance.capability,
    COMPILER_EVIDENCE_CAPABILITY,
    `${path}.capability`,
  );
  validateRevision(provenance.sourceRevision, `${path}.sourceRevision`);
  expectId(provenance.contextId, `${path}.contextId`);
  validateCompileProfile(provenance.profile, `${path}.profile`);
  return provenance;
}

function validateGeneratedCitation(value: unknown, path: string): void {
  const citation = expectRecord(value, path);
  const evidenceId = expectHash(citation.evidenceId, `${path}.evidenceId`);
  const view = expectRecord(citation.view, `${path}.view`);
  expectExact(view.kind, 'generated', `${path}.view.kind`);
  const viewUri = expectUri(view.uri, `${path}.view.uri`);
  if (viewUri !== compilerViewUri(evidenceId, 'generated')) {
    throw new Error(`${path}.view.uri does not bind its evidenceId.`);
  }
  const document = expectRecord(citation.document, `${path}.document`);
  expectHash(document.contentHash, `${path}.document.contentHash`);
  const documentRange = validateRange(
    document.range,
    `${path}.document.range`,
  );
  const mapping = expectRecord(citation.mapping, `${path}.mapping`);
  const mappingUri = expectUri(mapping.uri, `${path}.mapping.uri`);
  const sourceRange = validateRange(
    mapping.range,
    `${path}.mapping.range`,
  );
  const generatedRange = validateRange(
    mapping.generatedRange,
    `${path}.mapping.generatedRange`,
  );
  const sourceIdentity = validateSourceIdentity(
    mapping.sourceIdentity,
    `${path}.mapping.sourceIdentity`,
  );
  if (uriIdentityKey(mappingUri) !== uriIdentityKey(sourceIdentity.uri)) {
    throw new Error(`${path}.mapping.uri must match its source identity.`);
  }
  const provenance = expectRecord(mapping.provenance, `${path}.mapping.provenance`);
  expectExact(
    provenance.method,
    'line-directive',
    `${path}.mapping.provenance.method`,
  );
  expectExact(provenance.granularity, 'line', `${path}.mapping.provenance.granularity`);
  validateCompilerProvenance(
    provenance.evidence,
    `${path}.mapping.provenance.evidence`,
  );
  const directive = expectRecord(
    provenance.directive,
    `${path}.mapping.provenance.directive`,
  );
  const documentLine = expectNonNegativeInteger(
    directive.documentLine,
    `${path}.mapping.provenance.directive.documentLine`,
  );
  const sourceLine = expectNonNegativeInteger(
    directive.sourceLine,
    `${path}.mapping.provenance.directive.sourceLine`,
  );
  const sourceName = expectText(
    directive.sourceName,
    `${path}.mapping.provenance.directive.sourceName`,
  );
  if (
    !sameRange(documentRange, generatedRange)
    || documentRange.start.line !== documentRange.end.line
    || sourceRange.start.line !== sourceRange.end.line
    || documentLine >= generatedRange.start.line
    || sourceLine !== sourceRange.start.line
    || generatedRange.start.character !== sourceRange.start.character
    || generatedRange.end.character !== sourceRange.end.character
    || !sourceNameMatchesUri(mappingUri, sourceName)
  ) {
    throw new Error(
      `${path} must close one exact generated/source line pair and its preceding directive.`,
    );
  }
}

function validateCitationJoins(
  citations: readonly PassExplanationCitation[],
  causalSupported: boolean,
  causalCitationIds: ReadonlySet<string>,
): void {
  if (!causalSupported) return;
  const causalCitations = citations.filter(({ nodeId }) => (
    causalCitationIds.has(nodeId)
  ));
  if (causalCitations.length !== citations.length) {
    throw new Error(
      'A supported causal explanation must account for every displayed citation.',
    );
  }
  const sources = causalCitations.filter(
    (citation): citation is Extract<
      PassExplanationCitation,
      { readonly kind: 'source-pass' }
    > => citation.kind === 'source-pass',
  );
  const materials = causalCitations.filter(
    (citation): citation is Extract<
      PassExplanationCitation,
      { readonly kind: 'material-context' }
    > => citation.kind === 'material-context',
  );
  const contexts = causalCitations.filter(
    (citation): citation is Extract<
      PassExplanationCitation,
      { readonly kind: 'shader-context' }
    > => citation.kind === 'shader-context',
  );
  if (sources.length !== 1 || materials.length !== 1 || contexts.length !== 1) {
    throw new Error(
      'A supported causal explanation requires one source, Material, and Shader Context citation.',
    );
  }
  const source = sources[0]!;
  const material = materials[0]!;
  const context = contexts[0]!;
  const captured = context.correlation.context;
  const captureProvenance = context.correlation.evidence.provenance;
  const variants = causalCitations.filter(
    (citation): citation is Extract<
      PassExplanationCitation,
      { readonly kind: 'variant' }
    > => citation.kind === 'variant',
  );
  const compilers = causalCitations.filter(
    (citation): citation is Extract<
      PassExplanationCitation,
      { readonly kind: 'compiler' }
    > => citation.kind === 'compiler',
  );
  const generatedCitations = causalCitations.filter(
    (citation): citation is Extract<
      PassExplanationCitation,
      { readonly kind: 'generated-source' }
    > => citation.kind === 'generated-source',
  );

  for (const variant of variants) {
    if (
      !sameProgram(variant.context, captured)
      || variant.context.shaderName !== captured.shaderName
      || variant.context.stage !== captured.stage
      || variant.context.graphicsApi !== captureProvenance.graphicsApi
      || !sameAdapterSession(variant.build.provenance, material.provenance)
      || !sourceIdentityMatchesRevision(
        source.source,
        variant.build.provenance.sourceRevision,
      )
    ) {
      throw new Error(
        `Variant citation "${variant.nodeId}" does not close over the selected Context and source session.`,
      );
    }
  }

  for (const compiler of compilers) {
    const { record } = compiler;
    if (record.status === 'stale') {
      throw new Error(
        'Supported causal explanation cannot cite a stale compiler record.',
      );
    }
    if (
      record.contextId !== captured.id
      || record.provenance.contextId !== captured.id
      || record.profile.graphicsApi !== captureProvenance.graphicsApi
      || record.provenance.profile.graphicsApi
        !== captureProvenance.graphicsApi
      || !sameAdapterSession(record.provenance, material.provenance)
      || uriIdentityKey(record.sourceUri)
        !== uriIdentityKey(source.source.uri)
      || !sourceIdentityMatchesRevision(
        source.source,
        record.provenance.sourceRevision,
      )
    ) {
      throw new Error(
        `Compiler citation "${compiler.nodeId}" does not close over the selected Context and source session.`,
      );
    }
  }

  for (const variant of variants) {
    for (const compiler of compilers) {
      if (
        variant.build.provenance.buildTarget
          !== compiler.record.profile.platform
        || variant.build.provenance.buildTarget
          !== compiler.record.provenance.profile.platform
      ) {
        throw new Error(
          `Variant citation "${variant.nodeId}" and compiler citation "${compiler.nodeId}" disagree on platform.`,
        );
      }
    }
  }

  for (const generated of generatedCitations) {
    // The engine selects a generated citation's compiler owner through its
    // compiler-generated edge, which the answer does not carry. Re-derive the
    // owner from every owner-relative predicate the answer does carry: two
    // compiler records can legitimately share one evidenceId (the same capture
    // compiled under two profiles), so the evidenceId alone is not a key.
    const owners = compilers.filter(
      ({ record }) => (
        record.evidenceId === generated.evidenceId
        && record.views.some((view) => (
          view.kind === generated.view.kind
          && view.uri === generated.view.uri
          && view.contentHash === generated.document.contentHash
        ))
        && sameCompilerProvenance(
          generated.mapping.provenance.evidence,
          record.provenance,
        )
      ),
    );
    if (owners.length !== 1) {
      throw new Error(`Generated citation "${generated.nodeId}" has no unique compiler owner.`);
    }
    if (
      uriIdentityKey(generated.mapping.uri)
        !== uriIdentityKey(source.source.uri)
      || !sameSourceIdentity(
        generated.mapping.sourceIdentity,
        source.source,
      )
      || !containsRange(source.range, generated.mapping.range)
    ) {
      throw new Error(
        `Generated citation "${generated.nodeId}" does not bind its exact source mapping.`,
      );
    }
  }
}

function validateCitation(value: unknown, path: string): void {
  const citation = expectRecord(value, path);
  expectId(citation.nodeId, `${path}.nodeId`);
  const kind = expectString(citation.kind, `${path}.kind`) as PassExplanationCitation['kind'];
  if (!CITATION_KINDS.has(kind)) {
    throw new Error(`${path}.kind is not a supported citation kind.`);
  }
  switch (kind) {
    case 'source-pass':
      validateSourceIdentity(citation.source, `${path}.source`);
      validateShaderProgram(citation.program, `${path}.program`);
      validateRange(citation.range, `${path}.range`);
      break;
    case 'material-context': {
      const selectionId = expectId(
        citation.selectionId,
        `${path}.selectionId`,
      );
      validateMaterialAsset(citation.material, `${path}.material`);
      validateMaterialAsset(citation.shader, `${path}.shader`);
      if (citation.selectedProgram !== undefined) {
        validateProgram(citation.selectedProgram, `${path}.selectedProgram`);
      }
      const provenance = validateBasicProvenance(
        citation.provenance,
        `${path}.provenance`,
      );
      expectExact(
        provenance.capability,
        MATERIAL_CONTEXT_ADAPTER_FEATURE,
        `${path}.provenance.capability`,
      );
      const sourceRevision = expectId(
        provenance.sourceRevision,
        `${path}.provenance.sourceRevision`,
      );
      if (sourceRevision !== selectionId) {
        throw new Error(
          `${path}.provenance.sourceRevision must match selectionId.`,
        );
      }
      break;
    }
    case 'shader-context':
      validateCurrentCorrelation(citation.correlation, `${path}.correlation`);
      break;
    case 'variant': {
      validateVariantBuild(citation.build, `${path}.build`);
      validateVariantContext(citation.context, `${path}.context`);
      break;
    }
    case 'compiler':
      validateCompilerRecord(citation.record, `${path}.record`);
      break;
    case 'generated-source':
      validateGeneratedCitation(citation, path);
      break;
  }
}

function validateMaterialAsset(value: unknown, path: string): void {
  const asset = expectRecord(value, path);
  expectText(asset.name, `${path}.name`);
  expectText(asset.path, `${path}.path`);
  validateRevision(asset.revision, `${path}.revision`);
}

function validateSourceIdentity(
  value: unknown,
  path: string,
): {
  readonly uri: string;
  readonly sourceId: string;
  readonly contentHash: string;
} {
  const source = expectRecord(value, path);
  return {
    uri: expectUri(source.uri, `${path}.uri`),
    sourceId: expectText(source.sourceId, `${path}.sourceId`),
    contentHash: expectHash(source.contentHash, `${path}.contentHash`),
  };
}

function validateRevision(
  value: unknown,
  path: string,
): {
  readonly uri: string;
  readonly assetGuid: string;
  readonly contentHash: string;
} {
  const revision = expectRecord(value, path);
  return {
    uri: expectUri(revision.uri, `${path}.uri`),
    assetGuid: expectGuid(revision.assetGuid, `${path}.assetGuid`),
    contentHash: expectHash(revision.contentHash, `${path}.contentHash`),
  };
}

function validateProgram(
  value: unknown,
  path: string,
  shaderName = false,
): void {
  const program = expectRecord(value, path);
  if (shaderName) expectText(program.shaderName, `${path}.shaderName`);
  expectNonNegativeInteger(program.subShaderIndex, `${path}.subShaderIndex`);
  if (program.passIndex !== undefined) {
    expectNonNegativeInteger(program.passIndex, `${path}.passIndex`);
  }
  if (program.passName !== undefined) expectText(program.passName, `${path}.passName`);
}

function validateShaderProgram(value: unknown, path: string): void {
  const program = expectRecord(value, path);
  expectNonNegativeInteger(program.blockIndex, `${path}.blockIndex`);
  expectText(program.shaderName, `${path}.shaderName`);
  validateSelectedProgram(program, path);
  const stages = expectArray(program.stages, `${path}.stages`);
  if (stages.length > MAX_PASS_EXPLANATION_NESTED_ITEMS) {
    throw new Error(`${path}.stages exceeds its item boundary.`);
  }
  for (const [index, value] of stages.entries()) {
    const stage = expectRecord(value, `${path}.stages[${index}]`);
    expectOneOf(
      stage.stage,
      ['vertex', 'fragment', 'geometry', 'hull', 'domain', 'surface', 'kernel', 'raytracing'],
      `${path}.stages[${index}].stage`,
    );
    expectText(stage.entryPoint, `${path}.stages[${index}].entryPoint`);
    validateUniqueTextArray(
      stage.defines,
      `${path}.stages[${index}].defines`,
      MAX_PASS_EXPLANATION_NESTED_ITEMS,
    );
  }
  const sharedBlocks = expectArray(
    program.sharedBlockIndices,
    `${path}.sharedBlockIndices`,
  );
  if (sharedBlocks.length > MAX_PASS_EXPLANATION_NESTED_ITEMS) {
    throw new Error(`${path}.sharedBlockIndices exceeds its item boundary.`);
  }
  const seen = new Set<number>();
  for (const [index, value] of sharedBlocks.entries()) {
    const blockIndex = expectNonNegativeInteger(
      value,
      `${path}.sharedBlockIndices[${index}]`,
    );
    if (seen.has(blockIndex)) {
      throw new Error(`${path}.sharedBlockIndices repeats ${blockIndex}.`);
    }
    seen.add(blockIndex);
  }
}

function validateSelectedProgram(value: unknown, path: string): void {
  const program = expectRecord(value, path);
  validateProgram(program, path);
  if (program.passIndex === undefined && program.passName === undefined) {
    throw new Error(`${path} must identify a Pass.`);
  }
}

interface ValidatedPosition {
  readonly line: number;
  readonly character: number;
}

interface ValidatedRange {
  readonly start: ValidatedPosition;
  readonly end: ValidatedPosition;
}

function validateRange(value: unknown, path: string): ValidatedRange {
  const range = expectRecord(value, path);
  const start = validatePosition(range.start, `${path}.start`);
  const end = validatePosition(range.end, `${path}.end`);
  if (
    start.line > end.line
    || (start.line === end.line && start.character > end.character)
  ) {
    throw new Error(`${path} must be ordered.`);
  }
  return { start, end };
}

function validatePosition(
  value: unknown,
  path: string,
): ValidatedPosition {
  const position = expectRecord(value, path);
  return {
    line: expectNonNegativeInteger(position.line, `${path}.line`),
    character: expectNonNegativeInteger(
      position.character,
      `${path}.character`,
    ),
  };
}

function validateMeasuredCount(value: unknown, path: string): void {
  const count = expectRecord(value, path);
  const availability = expectString(count.availability, `${path}.availability`);
  if (availability === 'available') {
    const digits = expectString(count.count, `${path}.count`);
    if (!/^(?:0|[1-9][0-9]*)$/.test(digits)) {
      throw new Error(`${path}.count must be a non-negative base-10 integer.`);
    }
    if (count.reason !== undefined) {
      throw new Error(`${path} available count must not contain a reason.`);
    }
  } else if (availability === 'unavailable') {
    expectOneOf(
      count.reason,
      ['not-collected', 'build-failed', 'unsupported'],
      `${path}.reason`,
    );
    if (count.count !== undefined) {
      throw new Error(`${path} unavailable count must not contain a count.`);
    }
  } else {
    throw new Error(`${path}.availability is invalid.`);
  }
}

function validateCompileProfile(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const profile = expectRecord(value, path);
  expectText(profile.name, `${path}.name`);
  expectText(profile.platform, `${path}.platform`);
  expectText(profile.graphicsApi, `${path}.graphicsApi`);
  expectText(profile.capability, `${path}.capability`);
  return profile;
}

function validateBasicProvenance(
  value: unknown,
  path: string,
): Record<string, unknown> {
  const provenance = expectRecord(value, path);
  expectText(provenance.capability, `${path}.capability`);
  expectText(provenance.projectId, `${path}.projectId`);
  expectText(provenance.instanceId, `${path}.instanceId`);
  expectText(provenance.adapterVersion, `${path}.adapterVersion`);
  expectText(provenance.unityVersion, `${path}.unityVersion`);
  const collectedAt = expectPositiveFiniteNumber(
    provenance.collectedAt,
    `${path}.collectedAt`,
  );
  if (!Number.isFinite(new Date(collectedAt).getTime())) {
    throw new Error(`${path}.collectedAt must be a valid epoch millisecond.`);
  }
  return provenance;
}

function sameProgram(
  left: {
    readonly subShaderIndex: number;
    readonly passIndex?: number;
    readonly passName?: string;
  },
  right: {
    readonly subShaderIndex: number;
    readonly passIndex?: number;
    readonly passName?: string;
  } | undefined,
): boolean {
  if (!right || left.subShaderIndex !== right.subShaderIndex) return false;
  if (
    left.passIndex !== undefined
    && right.passIndex !== undefined
    && left.passIndex !== right.passIndex
  ) return false;
  if (
    left.passName !== undefined
    && right.passName !== undefined
    && left.passName !== right.passName
  ) return false;
  return (
    left.passIndex !== undefined && right.passIndex !== undefined
  ) || (
    left.passName !== undefined && right.passName !== undefined
  );
}

function sameExactProgram(
  left: {
    readonly subShaderIndex: number;
    readonly passIndex?: number;
    readonly passName?: string;
  },
  right: {
    readonly subShaderIndex: number;
    readonly passIndex?: number;
    readonly passName?: string;
  } | undefined,
): boolean {
  return right !== undefined
    && left.subShaderIndex === right.subShaderIndex
    && left.passIndex === right.passIndex
    && left.passName === right.passName;
}

function passIsIdentified(
  program: {
    readonly passIndex?: number;
    readonly passName?: string;
  } | undefined,
): boolean {
  return program !== undefined
    && (program.passIndex !== undefined || program.passName !== undefined);
}

function sameRevisionIdentity(
  left: {
    readonly uri: string;
    readonly assetGuid: string;
    readonly contentHash: string;
  },
  right: {
    readonly uri: string;
    readonly assetGuid: string;
    readonly contentHash: string;
  },
): boolean {
  return uriIdentityKey(left.uri) === uriIdentityKey(right.uri)
    && left.assetGuid.toLowerCase() === right.assetGuid.toLowerCase()
    && left.contentHash.toLowerCase() === right.contentHash.toLowerCase();
}

function sourceIdentityMatchesRevision(
  source: {
    readonly uri: string;
    readonly sourceId: string;
    readonly contentHash: string;
  },
  revision: {
    readonly uri: string;
    readonly assetGuid: string;
    readonly contentHash: string;
  },
): boolean {
  return uriIdentityKey(source.uri) === uriIdentityKey(revision.uri)
    && source.sourceId.toLowerCase() === revision.assetGuid.toLowerCase()
    && source.contentHash.toLowerCase() === revision.contentHash.toLowerCase();
}

function sameSourceIdentity(
  left: CompilerSourceIdentity,
  right: CompilerSourceIdentity,
): boolean {
  return uriIdentityKey(left.uri) === uriIdentityKey(right.uri)
    && left.sourceId.toLowerCase() === right.sourceId.toLowerCase()
    && left.contentHash.toLowerCase() === right.contentHash.toLowerCase();
}

function sameCompilerProvenance(
  left: CompilerEvidenceProvenance,
  right: CompilerEvidenceProvenance,
): boolean {
  return sameAdapterSession(left, right)
    && left.capability === right.capability
    && left.collectedAt === right.collectedAt
    && left.contextId === right.contextId
    && sameRevisionIdentity(left.sourceRevision, right.sourceRevision)
    && sameProfile(left.profile, right.profile);
}

function containsRange(
  container: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  },
  nested: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  },
): boolean {
  return positionAtOrBefore(container.start, nested.start)
    && positionAtOrBefore(nested.end, container.end);
}

function positionAtOrBefore(
  left: { readonly line: number; readonly character: number },
  right: { readonly line: number; readonly character: number },
): boolean {
  return left.line < right.line
    || (left.line === right.line && left.character <= right.character);
}

function sameAdapterSession(
  left: {
    readonly projectId: string;
    readonly instanceId: string;
    readonly adapterVersion: string;
    readonly unityVersion: string;
  },
  right: {
    readonly projectId: string;
    readonly instanceId: string;
    readonly adapterVersion: string;
    readonly unityVersion: string;
  },
): boolean {
  return left.projectId === right.projectId
    && left.instanceId === right.instanceId
    && left.adapterVersion === right.adapterVersion
    && left.unityVersion === right.unityVersion;
}

function sameRange(left: unknown, right: unknown): boolean {
  const leftRange = left as {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  const rightRange = right as typeof leftRange;
  return leftRange.start.line === rightRange.start.line
    && leftRange.start.character === rightRange.start.character
    && leftRange.end.line === rightRange.end.line
    && leftRange.end.character === rightRange.end.character;
}

function rangeMatchesExactText(
  range: ValidatedRange,
  text: string,
): boolean {
  return range.start.line === range.end.line
    && range.end.character - range.start.character === text.length;
}

function sameCapturedContext(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeywords = left.keywords as {
    readonly enabled: readonly string[];
    readonly incomplete: boolean;
  };
  const rightKeywords = right.keywords as typeof leftKeywords;
  return left.id === right.id
    && left.shaderName === right.shaderName
    && left.subShaderIndex === right.subShaderIndex
    && left.passIndex === right.passIndex
    && left.passName === right.passName
    && left.stage === right.stage
    && left.entryPoint === right.entryPoint
    && leftKeywords.incomplete === rightKeywords.incomplete
    && leftKeywords.enabled.length === rightKeywords.enabled.length
    && leftKeywords.enabled.every((keyword, index) => (
      keyword === rightKeywords.enabled[index]
    ));
}

function sameProfile(left: unknown, right: unknown): boolean {
  const leftProfile = left as {
    readonly name: string;
    readonly platform: string;
    readonly graphicsApi: string;
    readonly capability: string;
  };
  const rightProfile = right as typeof leftProfile;
  return leftProfile.name === rightProfile.name
    && leftProfile.platform === rightProfile.platform
    && leftProfile.graphicsApi === rightProfile.graphicsApi
    && leftProfile.capability === rightProfile.capability;
}

function compilerViewUri(evidenceId: string, kind: string): string {
  return `unity-shader-nav-compiler://evidence/${evidenceId}/${kind}.hlsl`;
}

function validateUniqueTextArray(
  value: unknown,
  path: string,
  maxLength: number,
): string[] {
  const values = expectArray(value, path);
  if (values.length > maxLength) throw new Error(`${path} exceeds its item boundary.`);
  const result: string[] = [];
  const unique = new Set<string>();
  for (const [index, item] of values.entries()) {
    const text = expectText(item, `${path}[${index}]`);
    if (unique.has(text)) throw new Error(`${path} repeats "${text}".`);
    unique.add(text);
    result.push(text);
  }
  return result;
}

function validateIdArray(
  value: unknown,
  path: string,
  maxLength: number,
): string[] {
  const values = expectArray(value, path);
  if (values.length > maxLength) throw new Error(`${path} exceeds its item boundary.`);
  const result: string[] = [];
  const unique = new Set<string>();
  for (const [index, item] of values.entries()) {
    const id = expectId(item, `${path}[${index}]`);
    if (unique.has(id)) throw new Error(`${path} repeats "${id}".`);
    unique.add(id);
    result.push(id);
  }
  return result;
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('undefined');
    return serialized;
  } catch {
    throw new Error('Pass explanation must be a bounded JSON value.');
  }
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string.`);
  return value;
}

function expectText(value: unknown, path: string): string {
  const text = expectString(value, path);
  if (
    text.trim().length === 0
    || text.length > MAX_DISPLAY_TEXT_LENGTH
    || /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new Error(`${path} must be non-empty and bounded.`);
  }
  return text;
}

function expectId(value: unknown, path: string): string {
  const id = expectString(value, path);
  if (
    id.trim().length === 0
    || id.length > MAX_PASS_EXPLANATION_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(id)
  ) throw new Error(`${path} must be a bounded printable identifier.`);
  return id;
}

function expectUri(value: unknown, path: string): string {
  const uri = expectString(value, path);
  if (
    uri.length === 0
    || uri.length > MAX_URI_LENGTH
    || /[\u0000-\u001f\u007f]/.test(uri)
  ) throw new Error(`${path} must be a bounded URI.`);
  try {
    new URL(uri);
  } catch {
    throw new Error(`${path} must be an absolute URI.`);
  }
  return uri;
}

function expectGuid(value: unknown, path: string): string {
  const guid = expectString(value, path);
  if (!/^[a-f0-9]{32}$/.test(guid)) {
    throw new Error(`${path} must be a lowercase 32-hex asset GUID.`);
  }
  return guid;
}

function expectHash(value: unknown, path: string): string {
  const hash = expectString(value, path);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest.`);
  }
  return hash;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}

function expectPositiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive safe integer.`);
  }
  return value as number;
}

function expectPositiveFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive finite number.`);
  }
  return value;
}

function expectExact(
  value: unknown,
  expected: string,
  path: string,
): void {
  if (value !== expected) throw new Error(`${path} must be "${expected}".`);
}

function expectOneOf(
  value: unknown,
  expected: readonly string[],
  path: string,
): string {
  const text = expectString(value, path);
  if (!expected.includes(text)) {
    throw new Error(`${path} must be one of ${expected.join(', ')}.`);
  }
  return text;
}
