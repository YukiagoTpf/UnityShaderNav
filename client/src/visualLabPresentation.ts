import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  MAX_VISUAL_LAB_IMAGE_DIMENSION,
  MAX_VISUAL_LAB_PNG_BYTES,
  VISUAL_LAB_ADAPTER_FEATURE,
  type VisualLabFrameEvidence,
  type VisualLabNanInfMask,
  type VisualLabPngImage,
  type VisualLabRenderTarget,
  type VisualLabSessionState,
  type VisualLabSlot,
  type VisualLabSlotState,
  type VisualLabStaleReason,
} from '@unity-shader-nav/shared';

export interface VisualLabClientSnapshot {
  readonly connection: 'connected' | 'disconnected';
  readonly session?: VisualLabSessionState;
  readonly activity?: {
    readonly kind: 'read-state' | 'use-current' | 'capture';
    readonly slot?: VisualLabSlot;
  };
  readonly message?: string;
}

interface PendingOperation {
  readonly generation: number;
  readonly kind: 'read-state' | 'use-current' | 'capture';
  readonly slot?: VisualLabSlot;
}

/**
 * Owns only client freshness and request generations. Unity rendering and
 * authoritative slot state remain server-owned.
 */
export class VisualLabClientSession {
  private generation = 0;
  private connection: VisualLabClientSnapshot['connection'] = 'connected';
  private session: VisualLabSessionState | undefined;
  private pending: PendingOperation | undefined;
  private message: string | undefined;

  snapshot(): VisualLabClientSnapshot {
    return {
      connection: this.connection,
      ...(this.session ? { session: this.session } : {}),
      ...(this.pending
        ? {
            activity: {
              kind: this.pending.kind,
              ...(this.pending.slot ? { slot: this.pending.slot } : {}),
            },
          }
        : {}),
      ...(this.message ? { message: this.message } : {}),
    };
  }

  beginUseCurrent(): number {
    const generation = ++this.generation;
    this.pending = { generation, kind: 'use-current' };
    this.message = undefined;
    return generation;
  }

  beginReadState(): number | undefined {
    if (this.connection !== 'connected' || this.pending) return undefined;
    const generation = ++this.generation;
    this.pending = { generation, kind: 'read-state' };
    this.message = undefined;
    return generation;
  }

  beginCapture(slot: VisualLabSlot): number | undefined {
    if (
      this.connection !== 'connected'
      || this.session?.status !== 'available'
      || this.pending
    ) return undefined;
    const generation = ++this.generation;
    this.pending = { generation, kind: 'capture', slot };
    this.message = undefined;
    return generation;
  }

  settle(
    generation: number,
    state: VisualLabSessionState,
    expected: PendingOperation['kind'],
    slot?: VisualLabSlot,
  ): boolean {
    if (
      this.pending?.generation !== generation
      || this.pending.kind !== expected
      || this.pending.slot !== slot
    ) return false;
    validateVisualLabSessionState(state);
    this.pending = undefined;
    this.session = state;
    this.message = undefined;
    return true;
  }

  fail(
    generation: number,
    expected: PendingOperation['kind'],
    message: string,
    slot?: VisualLabSlot,
  ): boolean {
    if (
      this.pending?.generation !== generation
      || this.pending.kind !== expected
      || this.pending.slot !== slot
    ) return false;
    this.pending = undefined;
    this.message = message;
    return true;
  }

  applyServerState(state: VisualLabSessionState): void {
    validateVisualLabSessionState(state);
    this.generation++;
    this.pending = undefined;
    this.session = state;
    this.message = undefined;
  }

  invalidate(reason: VisualLabStaleReason): void {
    this.generation++;
    this.pending = undefined;
    if (this.session) this.session = staleVisualLabSession(this.session, reason);
    this.message = staleReasonMessage(reason);
  }

  connect(): void {
    this.connection = 'connected';
    if (this.session) {
      this.message = 'Adapter reconnected. Use Current Selected Material to refresh its identity.';
    }
  }

  disconnect(): void {
    this.invalidate('adapter-disconnected');
    this.connection = 'disconnected';
  }
}

export interface VisualLabHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
}

export function renderVisualLabHtml(
  snapshot: VisualLabClientSnapshot,
  options: VisualLabHtmlOptions,
): string {
  const nonce = escapeHtml(options.nonce);
  const session = snapshot.session;
  const busy = snapshot.activity !== undefined;
  const disconnected = snapshot.connection === 'disconnected';
  const available = session?.status === 'available';
  const frames = session ? {
    before: retainedFrame(session.before),
    after: retainedFrame(session.after),
  } : {};

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnityShaderNav Visual Lab</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.5 var(--vscode-font-family); }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 18px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 4px; font-size: 21px; }
    h2 { font-size: 16px; }
    h3 { margin: 16px 0 8px; font-size: 13px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .target, .delta { padding: 14px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editorWidget-background); }
    .badge { display: inline-block; padding: 2px 7px; border: 1px solid currentColor; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .04em; }
    .current, .unchanged { color: var(--vscode-testing-iconPassed); }
    .stale, .failed, .changed { color: var(--vscode-testing-iconFailed); }
    .pending { color: var(--vscode-progressBar-background); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 22px; }
    button { padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .notice { margin-bottom: 18px; padding: 10px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
    .captures { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 18px; }
    .capture { min-width: 0; padding: 16px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    .capture-heading { display: flex; justify-content: space-between; gap: 12px; }
    .images { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
    figure { min-width: 0; margin: 0; }
    figcaption { min-height: 3em; margin-bottom: 5px; color: var(--vscode-descriptionForeground); }
    img, canvas { display: block; width: 100%; height: auto; border: 1px solid var(--vscode-panel-border); image-rendering: pixelated; background: repeating-conic-gradient(#222 0 25%, #333 0 50%) 50% / 12px 12px; }
    dl { display: grid; grid-template-columns: minmax(120px, auto) 1fr; gap: 4px 12px; margin: 0; }
    dt { color: var(--vscode-descriptionForeground); }
    dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    .empty { display: grid; min-height: 190px; place-items: center; padding: 20px; border: 1px dashed var(--vscode-panel-border); color: var(--vscode-descriptionForeground); text-align: center; }
    code { font-family: var(--vscode-editor-font-family); }
    .delta { margin-top: 18px; }
    @media (max-width: 720px) { header { display: block; } .images { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>UnityShaderNav Visual Lab</h1>
      <p class="muted">Controlled Unity rendering. Captures occur only when you request them.</p>
    </div>
    ${sessionBadge(snapshot)}
  </header>
  ${targetSummary(session)}
  <div class="actions">
    <button id="use-current"${busy || disconnected ? ' disabled' : ''}>Use Current Selected Material</button>
    <button id="capture-before" class="secondary"${busy || disconnected || !available ? ' disabled' : ''}>Capture Before</button>
    <button id="capture-after" class="secondary"${busy || disconnected || !available ? ' disabled' : ''}>Capture After / Refresh</button>
  </div>
  ${snapshot.message ? `<div class="notice" role="status">${escapeHtml(snapshot.message)}</div>` : ''}
  <main class="captures">
    ${slotCard('Before', session?.before)}
    ${slotCard('After / Refresh', session?.after)}
  </main>
  ${frames.before && frames.after ? identityDelta(frames.before.target, frames.after.target) : ''}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('use-current').addEventListener('click', () => vscode.postMessage({ type: 'use-current-selected-material' }));
    document.getElementById('capture-before').addEventListener('click', () => vscode.postMessage({ type: 'capture-before' }));
    document.getElementById('capture-after').addEventListener('click', () => vscode.postMessage({ type: 'capture-after' }));
    for (const canvas of document.querySelectorAll('canvas[data-r8-mask]')) {
      const bytes = Uint8Array.from(atob(canvas.dataset.r8Mask), (value) => value.charCodeAt(0));
      const pixels = new Uint8ClampedArray(bytes.length * 4);
      for (let index = 0; index < bytes.length; index++) {
        const value = bytes[index];
        const offset = index * 4;
        pixels[offset] = value;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = value;
        pixels[offset + 3] = 255;
      }
      canvas.getContext('2d').putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      canvas.removeAttribute('data-r8-mask');
    }
  </script>
</body>
</html>`;
}

export function staleVisualLabSession(
  state: VisualLabSessionState,
  reason: VisualLabStaleReason,
): VisualLabSessionState {
  const pinnedTarget = state.status === 'available'
    ? state.target
    : state.pinnedTarget;
  return {
    status: 'unavailable',
    reason: reason === 'adapter-disconnected' || reason === 'domain-reloaded'
      ? 'adapter-disconnected'
      : 'invalid-target',
    ...(pinnedTarget ? { pinnedTarget } : {}),
    before: staleSlot(state.before, reason),
    after: staleSlot(state.after, reason),
  };
}

export function validateVisualLabSessionState(state: VisualLabSessionState): void {
  validateSlot(state.before);
  validateSlot(state.after);
  if (state.before.slot !== 'before' || state.after.slot !== 'after') {
    throw new Error('Visual Lab session slots are reversed.');
  }
}

export function validatedPngDataUri(image: VisualLabPngImage): string {
  if (image.mediaType !== 'image/png' || image.encoding !== 'base64') {
    throw new Error('Visual Lab accepts only base64-encoded image/png.');
  }
  validateDimensions(image.width, image.height);
  if (
    !Number.isSafeInteger(image.byteLength)
    || image.byteLength <= 0
    || image.byteLength > MAX_VISUAL_LAB_PNG_BYTES
  ) throw new Error(`Visual Lab PNG exceeds the ${MAX_VISUAL_LAB_PNG_BYTES}-byte boundary.`);
  const bytes = decodeCanonicalBase64(image.data, 'Visual Lab PNG');
  if (bytes.byteLength !== image.byteLength) {
    throw new Error('Visual Lab PNG byte length does not match its evidence.');
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error('Visual Lab image does not have a PNG signature.');
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Visual Lab PNG does not begin with IHDR.');
  }
  if (bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) {
    throw new Error('Visual Lab PNG dimensions do not match its evidence.');
  }
  if (!/^[a-f0-9]{64}$/.test(image.sha256)) {
    throw new Error('Visual Lab PNG SHA-256 is malformed.');
  }
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== image.sha256) {
    throw new Error('Visual Lab PNG SHA-256 does not match its evidence.');
  }
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

export function validatedNanInfMask(mask: VisualLabNanInfMask): string {
  if (
    mask.format !== 'r8'
    || mask.origin !== 'top-left'
    || mask.layout !== 'row-major'
    || mask.encoding !== 'base64'
  ) throw new Error('Visual Lab diagnostic must be a top-left row-major R8 mask.');
  validateDimensions(mask.width, mask.height);
  const expectedBytes = mask.width * mask.height;
  if (mask.byteLength !== expectedBytes) {
    throw new Error('Visual Lab R8 mask must contain exactly one byte per pixel.');
  }
  const bytes = decodeCanonicalBase64(mask.data, 'Visual Lab R8 mask');
  if (bytes.byteLength !== expectedBytes) {
    throw new Error('Visual Lab R8 mask payload length does not match its evidence.');
  }
  let maskedPixelCount = 0;
  for (const value of bytes) {
    if (value !== 0 && value !== 255) {
      throw new Error('Visual Lab R8 mask pixels must be exactly 0 or 255.');
    }
    if (value === 255) maskedPixelCount++;
  }
  for (const count of [
    mask.nanPixelCount,
    mask.infinitePixelCount,
    mask.maskedPixelCount,
  ]) {
    if (!Number.isSafeInteger(count) || count < 0 || count > expectedBytes) {
      throw new Error('Visual Lab diagnostic counts must be bounded safe integers.');
    }
  }
  if (
    mask.nanPixelCount + mask.infinitePixelCount !== mask.maskedPixelCount
    || mask.maskedPixelCount !== maskedPixelCount
  ) throw new Error('Visual Lab diagnostic counts do not match the server-provided mask.');
  return bytes.toString('base64');
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

function validateSlot(slot: VisualLabSlotState): void {
  if (slot.status === 'current') validateFrame(slot.frame, slot.slot);
  if (slot.status === 'stale') validateFrame(slot.frame, slot.slot);
  if (slot.status === 'capturing' && slot.previous) {
    validateFrame(slot.previous.frame, slot.slot);
  }
  if (slot.status === 'failed' && slot.previous) {
    validateFrame(slot.previous.frame, slot.slot);
  }
}

function validateFrame(frame: VisualLabFrameEvidence, slot: VisualLabSlot): void {
  if (frame.capability !== VISUAL_LAB_ADAPTER_FEATURE) {
    throw new Error('Visual Lab frame capability is not visual-lab-render/v1.');
  }
  if (frame.slot !== slot) throw new Error('Visual Lab frame is in the wrong comparison slot.');
  if (!Number.isSafeInteger(frame.requestGeneration) || frame.requestGeneration < 1) {
    throw new Error('Visual Lab request generation must be a positive safe integer.');
  }
  if (
    !Number.isSafeInteger(frame.capturedAt)
    || frame.capturedAt <= 0
    || !Number.isFinite(new Date(frame.capturedAt).getTime())
  ) {
    throw new Error('Visual Lab capture timestamp must be a positive epoch millisecond.');
  }
  validatedPngDataUri(frame.image);
  const mask = frame.diagnostic.nanInfMask;
  validatedNanInfMask(mask);
  if (mask.width !== frame.image.width || mask.height !== frame.image.height) {
    throw new Error('Visual Lab diagnostic dimensions do not match the preview image.');
  }
}

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width > MAX_VISUAL_LAB_IMAGE_DIMENSION
    || height > MAX_VISUAL_LAB_IMAGE_DIMENSION
  ) throw new Error(
    `Visual Lab dimensions must be within ${MAX_VISUAL_LAB_IMAGE_DIMENSION}x${MAX_VISUAL_LAB_IMAGE_DIMENSION}.`,
  );
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) throw new Error(`${label} is not canonical base64.`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64.`);
  return bytes;
}

function staleSlot(
  slot: VisualLabSlotState,
  reason: VisualLabStaleReason,
): VisualLabSlotState {
  if (slot.status === 'current' || slot.status === 'stale') {
    return { status: 'stale', slot: slot.slot, reason, frame: slot.frame };
  }
  if ((slot.status === 'capturing' || slot.status === 'failed') && slot.previous) {
    return {
      status: 'stale',
      slot: slot.slot,
      reason,
      frame: slot.previous.frame,
    };
  }
  return { status: 'empty', slot: slot.slot };
}

function retainedFrame(slot: VisualLabSlotState): VisualLabFrameEvidence | undefined {
  if (slot.status === 'current' || slot.status === 'stale') return slot.frame;
  if (slot.status === 'capturing' || slot.status === 'failed') {
    return slot.previous?.frame;
  }
  return undefined;
}

function sessionBadge(snapshot: VisualLabClientSnapshot): string {
  if (snapshot.connection === 'disconnected') {
    return '<span class="badge failed">ADAPTER DISCONNECTED</span>';
  }
  if (snapshot.activity) return '<span class="badge pending">REQUEST IN FLIGHT</span>';
  if (!snapshot.session) return '<span class="badge">NO TARGET</span>';
  if (snapshot.session.status === 'unavailable') {
    return '<span class="badge failed">TARGET UNAVAILABLE</span>';
  }
  const slots = [snapshot.session.before, snapshot.session.after];
  return slots.some(({ status }) => status === 'stale')
    ? '<span class="badge stale">STALE FRAME RETAINED</span>'
    : '<span class="badge current">TARGET AVAILABLE</span>';
}

function targetSummary(state: VisualLabSessionState | undefined): string {
  if (!state) {
    return '<section class="target"><strong>No Material target selected</strong><div class="muted">Use the current Material selected in the connected Unity Editor.</div></section>';
  }
  if (state.status === 'unavailable') {
    const retained = state.pinnedTarget
      ? `<div class="muted">Pinned: ${escapeHtml(state.pinnedTarget.material.name)} · ${escapeHtml(state.pinnedTarget.material.path)}</div>`
      : '';
    return `<section class="target"><strong>Visual Lab unavailable</strong><div class="muted">${escapeHtml(unavailableReasonMessage(state.reason))}</div>${retained}</section>`;
  }
  return `<section class="target" aria-label="Pinned Material target">
    <strong>${escapeHtml(state.target.material.name)} · ${escapeHtml(state.target.shaderContext.shaderName)}</strong>
    <div class="muted">${escapeHtml(state.target.material.path)} · asset ${escapeHtml(state.target.material.revision.assetGuid)}</div>
  </section>`;
}

function slotCard(title: string, slot: VisualLabSlotState | undefined): string {
  const frame = slot ? retainedFrame(slot) : undefined;
  if (!slot || !frame) {
    const status = slotStatusMessage(slot);
    return `<section class="capture"><div class="capture-heading"><h2>${escapeHtml(title)}</h2>${slotBadge(slot)}</div><div class="empty">${escapeHtml(status)}</div></section>`;
  }
  validateFrame(frame, frame.slot);
  const imageUri = validatedPngDataUri(frame.image);
  const mask = frame.diagnostic.nanInfMask;
  const maskData = escapeHtml(validatedNanInfMask(mask));
  return `<section class="capture">
    <div class="capture-heading"><h2>${escapeHtml(title)}</h2>${slotBadge(slot)}</div>
    ${slotStatusDetail(slot)}
    <div class="images">
      <figure>
        <figcaption>Unity preview</figcaption>
        <img src="${imageUri}" width="${frame.image.width}" height="${frame.image.height}" alt="${escapeHtml(title)} Unity preview">
      </figure>
      <figure>
        <figcaption>Server NaN/Inf mask · NaN ${mask.nanPixelCount} · Inf ${mask.infinitePixelCount} · masked ${mask.maskedPixelCount}</figcaption>
        <canvas width="${mask.width}" height="${mask.height}" data-r8-mask="${maskData}" aria-label="${escapeHtml(title)} server-provided NaN and Inf mask"></canvas>
      </figure>
    </div>
    <h3>Complete provenance</h3>
    <dl>${provenanceRows(frame)}</dl>
  </section>`;
}

function slotBadge(slot: VisualLabSlotState | undefined): string {
  const status = slot?.status ?? 'empty';
  const cssClass = status === 'current'
    ? 'current'
    : status === 'stale' || status === 'failed'
      ? 'stale'
      : status === 'capturing'
        ? 'pending'
        : '';
  return `<span class="badge ${cssClass}">${escapeHtml(status.toUpperCase())}</span>`;
}

function slotStatusDetail(slot: VisualLabSlotState): string {
  const message = slotStatusMessage(slot);
  return message ? `<p class="muted">${escapeHtml(message)}</p>` : '';
}

function slotStatusMessage(slot: VisualLabSlotState | undefined): string {
  if (!slot || slot.status === 'empty') {
    return 'No capture. Rendering is never started in the background.';
  }
  if (slot.status === 'capturing') return 'Unity render request is in flight; any retained frame is not replaced yet.';
  if (slot.status === 'stale') return `STALE: ${staleReasonMessage(slot.reason)}`;
  if (slot.status === 'failed') return `Capture failed: ${slot.reason}. Any previous frame remains visible with its own freshness.`;
  return '';
}

function provenanceRows(frame: VisualLabFrameEvidence): string {
  const { target } = frame;
  const context = [
    target.shaderContext.shaderName,
    `SubShader ${target.shaderContext.subShaderIndex}`,
    `Pass ${target.shaderContext.passIndex}`,
    target.shaderContext.passName,
    target.shaderContext.stage,
    target.shaderContext.entryPoint,
  ].filter((part): part is string => part !== undefined).join(' · ');
  const keywords = [
    `material [${target.shaderContext.keywords.material.join(', ')}]`,
    `global [${target.shaderContext.keywords.global.join(', ')}]`,
    `engine-added [${target.shaderContext.keywords.engineAdded.join(', ')}]`,
  ].join(' · ');
  const pipelineRevision = [
    target.pipeline.assetGuid,
    target.pipeline.contentHash,
  ].filter((part): part is string => part !== undefined).join(' · ');
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Captured at', new Date(frame.capturedAt).toISOString()],
    ['Request generation', String(frame.requestGeneration)],
    ['Context revision', target.contextRevision],
    ['Source', `${target.source.name} · ${target.source.path} · ${target.source.revision.uri}`],
    ['Source identity', `${target.source.revision.assetGuid} · ${target.source.revision.contentHash}`],
    ['Material', `${target.material.name} · ${target.material.path} · ${target.material.revision.uri}`],
    ['Material identity', `${target.material.revision.assetGuid} · ${target.material.revision.contentHash}`],
    ['Shader Context', context],
    ['Final draw keywords', keywords],
    ['Render pipeline', `${target.pipeline.kind} · ${target.pipeline.name} · ${target.pipeline.id}${pipelineRevision ? ` · ${pipelineRevision}` : ''}`],
    ['Graphics profile', `${target.profile.id} · ${target.profile.buildTarget} · ${target.profile.graphicsApi} · quality ${target.profile.qualityLevel}`],
    ['Render target', `${target.profile.renderTarget.width}x${target.profile.renderTarget.height} · ${target.profile.renderTarget.format}`],
    ['Color space', target.colorSpace],
    ['Adapter', `Unity ${target.adapter.unityVersion} · Adapter ${target.adapter.adapterVersion}`],
    ['Adapter identity', `${target.adapter.projectId} · ${target.adapter.instanceId}`],
    ['Selection identity', target.selectionId],
    ['Render input identity', target.renderInputId],
    ['Preview PNG', `${frame.image.byteLength} bytes · sha256 ${frame.image.sha256}`],
  ];
  return rows.map(([label, value]) => (
    `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code></dd>`
  )).join('');
}

function identityDelta(
  before: VisualLabRenderTarget,
  after: VisualLabRenderTarget,
): string {
  const dimensions: ReadonlyArray<readonly [string, string, string]> = [
    ['Selection', before.selectionId, after.selectionId],
    ['Material Context revision', before.contextRevision, after.contextRevision],
    ['Material revision', revisionKey(before.material.revision), revisionKey(after.material.revision)],
    ['Source revision', revisionKey(before.source.revision), revisionKey(after.source.revision)],
    ['Shader Context', JSON.stringify(before.shaderContext), JSON.stringify(after.shaderContext)],
    ['Pipeline', JSON.stringify(before.pipeline), JSON.stringify(after.pipeline)],
    ['Graphics profile', JSON.stringify(before.profile), JSON.stringify(after.profile)],
    ['Color space', before.colorSpace, after.colorSpace],
    ['Adapter instance', before.adapter.instanceId, after.adapter.instanceId],
    ['Render input', before.renderInputId, after.renderInputId],
  ];
  const rows = dimensions.map(([label, left, right]) => {
    const changed = left !== right;
    const status = changed ? 'changed' : 'unchanged';
    return `<dt>${escapeHtml(label)}</dt><dd class="${status}"><strong>${status.toUpperCase()}</strong>${changed ? ` · Before ${escapeHtml(left)} · After ${escapeHtml(right)}` : ''}</dd>`;
  }).join('');
  return `<section class="delta"><h2>Before / After identity delta</h2><dl>${rows}</dl></section>`;
}

function revisionKey(revision: { readonly assetGuid: string; readonly contentHash: string }): string {
  return `${revision.assetGuid}:${revision.contentHash}`;
}

function unavailableReasonMessage(
  reason: Extract<VisualLabSessionState, { status: 'unavailable' }>['reason'],
): string {
  switch (reason) {
    case 'no-adapter':
      return 'No Unity Editor Adapter is connected.';
    case 'adapter-disconnected':
      return 'The Unity Editor Adapter is disconnected.';
    case 'capability-unavailable':
      return 'The connected Adapter does not advertise visual-lab-render/v1.';
    case 'context-unavailable':
      return 'The selected Material does not have a complete render Context.';
    case 'no-selection':
      return 'No Material is selected in the connected Unity Editor.';
    case 'target-description-unavailable':
      return 'The selected Material or Shader identity is incomplete.';
    case 'invalid-target':
      return 'The pinned Material target is no longer valid.';
    case 'invalid-evidence':
      return 'The Adapter supplied invalid Visual Lab evidence.';
  }
}

function staleReasonMessage(reason: VisualLabStaleReason): string {
  switch (reason) {
    case 'selection-changed':
      return 'the Unity Material selection changed.';
    case 'material-changed':
      return 'the selected Material changed.';
    case 'material-revision-changed':
      return 'the pinned Material revision changed.';
    case 'source-revision-changed':
      return 'the source revision changed.';
    case 'shader-context-changed':
      return 'the Shader Context changed.';
    case 'pipeline-changed':
      return 'the render pipeline changed.';
    case 'profile-changed':
      return 'the graphics profile changed.';
    case 'color-space-changed':
      return 'the color space changed.';
    case 'adapter-instance-changed':
      return 'the Adapter instance changed.';
    case 'render-input-changed':
      return 'the controlled render input changed.';
    case 'adapter-disconnected':
      return 'the Unity Editor Adapter disconnected.';
    case 'domain-reloaded':
      return 'the Unity domain reloaded.';
    case 'identity-changed':
      return 'one or more render identity dimensions changed.';
  }
}
