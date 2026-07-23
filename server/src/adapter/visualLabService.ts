import {
  type VisualLabCaptureFailureReason,
  type VisualLabFrameEvidence,
  type VisualLabRenderRequest,
  type VisualLabRenderTarget,
  type VisualLabRetainedFrame,
  type VisualLabSelectionIdentity,
  type VisualLabSessionState,
  type VisualLabSlot,
  type VisualLabSlotState,
  type VisualLabStaleReason,
  type VisualLabUnavailableReason,
} from '@unity-shader-nav/shared';
import {
  cloneVisualLabFrameEvidence,
  cloneVisualLabRenderTarget,
  cloneVisualLabSelectionIdentity,
  cloneVisualLabTargetDescription,
  validateVisualLabFrameEvidence,
  validateVisualLabTargetDescription,
  validVisualLabSelectionIdentity,
  visualLabRenderTargetKey,
  visualLabSelectionKey,
  type VisualLabSelectionProvider,
  type VisualLabSource,
} from './visualLabSource';

export interface VisualLabServiceOptions {
  readonly source: VisualLabSource;
  readonly selectionProvider: VisualLabSelectionProvider;
  readonly now?: () => number;
}

interface ActiveCapture {
  readonly generation: number;
  readonly controller: AbortController;
}

interface ActiveSelection {
  readonly operation: number;
  readonly controller: AbortController;
}

/**
 * Owns one explicitly pinned Visual Lab session.
 *
 * State reads never consult Unity and therefore cannot silently adopt its
 * current selection. Only selectCurrentTarget(documentUri) changes the pin.
 */
export class VisualLabService {
  private readonly now: () => number;
  private readonly listeners = new Set<(state: VisualLabSessionState) => void>();
  private readonly activeCaptures = new Map<VisualLabSlot, ActiveCapture>();
  private readonly sourceSubscription: { dispose(): void } | undefined;
  private sessionState: VisualLabSessionState = {
    status: 'unavailable',
    reason: 'no-selection',
    before: emptySlot('before'),
    after: emptySlot('after'),
  };
  private pinnedSelection: VisualLabSelectionIdentity | undefined;
  private pinnedTarget: VisualLabRenderTarget | undefined;
  private nextRequestGeneration = 0;
  private nextSelectionOperation = 0;
  private activeSelection: ActiveSelection | undefined;
  private pinnedDocumentUri: string | undefined;

  constructor(private readonly options: VisualLabServiceOptions) {
    this.now = options.now ?? Date.now;
    this.sourceSubscription = options.source.onDidInvalidate?.((reason) => {
      this.invalidate(reason);
    });
  }

  /** A defensive full snapshot. This method has no Adapter or provider side effects. */
  state(): VisualLabSessionState {
    return cloneSessionState(this.sessionState);
  }

  onDidChange(listener: (state: VisualLabSessionState) => void): {
    dispose(): void;
  } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /**
   * Explicit user action: resolve the current Material Context into a complete
   * Adapter-owned final draw target, then pin it.
   */
  async selectCurrentTarget(
    documentUri: string,
  ): Promise<VisualLabSessionState> {
    if (documentUri.trim().length === 0) {
      this.setUnavailable('invalid-target', 'identity-changed');
      return this.state();
    }
    this.activeSelection?.controller.abort();
    const operation = ++this.nextSelectionOperation;
    const controller = new AbortController();
    this.activeSelection = { operation, controller };

    let selected;
    try {
      selected = await this.options.selectionProvider.selectedVisualLabMaterial(
        documentUri,
      );
    } catch {
      if (this.isObsoleteSelection(operation)) return this.state();
      this.setUnavailable('context-unavailable', 'identity-changed');
      return this.state();
    }
    if (this.isObsoleteSelection(operation)) return this.state();
    if (selected.availability === 'unavailable') {
      this.setUnavailable(
        selected.reason,
        staleReasonForUnavailable(selected.reason),
      );
      return this.state();
    }
    if (!validVisualLabSelectionIdentity(selected.selection)) {
      this.setUnavailable('invalid-target', 'identity-changed');
      return this.state();
    }
    const selection = cloneVisualLabSelectionIdentity(selected.selection);
    const request = { selection };

    let reported: unknown;
    try {
      reported = await this.options.source.describePreviewTarget(
        request,
        controller.signal,
      );
    } catch {
      if (this.isObsoleteSelection(operation)) return this.state();
      this.setUnavailable(
        'target-description-unavailable',
        'identity-changed',
      );
      return this.state();
    }
    if (this.isObsoleteSelection(operation)) return this.state();
    const failure = validateVisualLabTargetDescription(reported, request);
    if (failure) {
      this.setUnavailable(
        failure === 'identity-mismatch' ? 'invalid-target' : 'invalid-evidence',
        'identity-changed',
      );
      return this.state();
    }

    const description = cloneVisualLabTargetDescription(reported);
    this.pin(documentUri, selection, description.target);
    this.activeSelection = undefined;
    return this.state();
  }

  /** Capture one explicit comparison slot without changing the pinned target. */
  async capture(slot: VisualLabSlot): Promise<VisualLabSessionState> {
    if (!this.pinnedSelection || !this.pinnedTarget) return this.state();
    if (this.sessionState.status !== 'available') return this.state();

    this.activeCaptures.get(slot)?.controller.abort();
    const generation = ++this.nextRequestGeneration;
    const controller = new AbortController();
    this.activeCaptures.set(slot, { generation, controller });
    const selection = cloneVisualLabSelectionIdentity(this.pinnedSelection);
    const target = cloneVisualLabRenderTarget(this.pinnedTarget);
    this.setSlot(slot, {
      status: 'capturing',
      slot,
      requestGeneration: generation,
      ...retainedProperty(this.slot(slot)),
    });
    this.publish();

    const latestSelection = await this.readSelectionForCapture(
      slot,
      generation,
    );
    if (!latestSelection) return this.state();
    if (
      visualLabSelectionKey(latestSelection) !== visualLabSelectionKey(selection)
    ) {
      this.invalidate(selectionChangeReason(selection, latestSelection));
      this.failActiveCapture(slot, generation, 'identity-mismatch');
      return this.state();
    }

    const describeRequest = { selection: latestSelection };
    let described: unknown;
    try {
      described = await this.options.source.describePreviewTarget(
        describeRequest,
        controller.signal,
      );
    } catch {
      this.failActiveCapture(slot, generation, 'source-unavailable');
      return this.state();
    }
    if (!this.isActiveCapture(slot, generation)) return this.state();
    const descriptionFailure = validateVisualLabTargetDescription(
      described,
      describeRequest,
    );
    if (descriptionFailure) {
      this.failActiveCapture(slot, generation, descriptionFailure);
      return this.state();
    }
    const latestTarget = cloneVisualLabTargetDescription(described).target;
    if (
      visualLabRenderTargetKey(latestTarget)
      !== visualLabRenderTargetKey(target)
    ) {
      this.invalidate(targetChangeReason(target, latestTarget));
      this.failActiveCapture(slot, generation, 'identity-mismatch');
      return this.state();
    }

    const renderRequest: VisualLabRenderRequest = {
      slot,
      requestGeneration: generation,
      target,
    };
    let reported: unknown;
    try {
      reported = await this.options.source.renderPreview(
        renderRequest,
        controller.signal,
      );
    } catch {
      this.failActiveCapture(slot, generation, 'render-failed');
      return this.state();
    }
    if (!this.isActiveCapture(slot, generation)) return this.state();
    const failure = validateVisualLabFrameEvidence(
      reported,
      renderRequest,
      this.now(),
    );
    if (failure) {
      this.failActiveCapture(slot, generation, failure);
      return this.state();
    }
    if (
      !this.pinnedTarget
      || visualLabRenderTargetKey(this.pinnedTarget)
        !== visualLabRenderTargetKey(target)
    ) return this.state();

    this.activeCaptures.delete(slot);
    this.setSlot(slot, {
      status: 'current',
      slot,
      frame: cloneVisualLabFrameEvidence(reported as VisualLabFrameEvidence),
    });
    this.publish();
    return this.state();
  }

  /** LSP-side selection/source/Context notifications call this immediately. */
  invalidate(reason: VisualLabStaleReason): void {
    this.abortCaptures();
    this.abortSelection();
    const before = staleSlot(this.slot('before'), reason);
    const after = staleSlot(this.slot('after'), reason);
    if (
      reason === 'adapter-disconnected'
      || reason === 'domain-reloaded'
    ) {
      this.sessionState = {
        status: 'unavailable',
        reason: 'adapter-disconnected',
        ...(this.pinnedTarget
          ? { pinnedTarget: cloneVisualLabRenderTarget(this.pinnedTarget) }
          : {}),
        before,
        after,
      };
    } else {
      this.sessionState = {
        status: 'unavailable',
        reason: this.pinnedTarget ? 'invalid-target' : 'context-unavailable',
        ...(this.pinnedTarget
          ? { pinnedTarget: cloneVisualLabRenderTarget(this.pinnedTarget) }
          : {}),
        before,
        after,
      };
    }
    this.publish();
  }

  markSelectionChanged(): void {
    this.invalidate('selection-changed');
  }

  markMaterialChanged(): void {
    this.invalidate('material-revision-changed');
  }

  markSourceChanged(): void {
    this.invalidate('source-revision-changed');
  }

  markShaderContextChanged(): void {
    this.invalidate('shader-context-changed');
  }

  dispose(): void {
    this.abortCaptures();
    this.abortSelection();
    this.sourceSubscription?.dispose();
    this.listeners.clear();
  }

  private async readSelectionForCapture(
    slot: VisualLabSlot,
    generation: number,
  ): Promise<VisualLabSelectionIdentity | undefined> {
    let selected;
    try {
      if (!this.pinnedDocumentUri) {
        this.setUnavailable('context-unavailable', 'identity-changed');
        return undefined;
      }
      selected = await this.options.selectionProvider.selectedVisualLabMaterial(
        this.pinnedDocumentUri,
      );
    } catch {
      if (this.isActiveCapture(slot, generation)) {
        this.setUnavailable('context-unavailable', 'identity-changed');
      }
      return undefined;
    }
    if (!this.isActiveCapture(slot, generation)) return undefined;
    if (selected.availability === 'unavailable') {
      this.setUnavailable(
        selected.reason,
        staleReasonForUnavailable(selected.reason),
      );
      return undefined;
    }
    if (!validVisualLabSelectionIdentity(selected.selection)) {
      this.setUnavailable('invalid-target', 'identity-changed');
      return undefined;
    }
    return cloneVisualLabSelectionIdentity(selected.selection);
  }

  private pin(
    documentUri: string,
    selection: VisualLabSelectionIdentity,
    target: VisualLabRenderTarget,
  ): void {
    this.abortCaptures();
    const previousTarget = this.pinnedTarget;
    const changed = previousTarget
      ? visualLabRenderTargetKey(previousTarget)
        !== visualLabRenderTargetKey(target)
      : false;
    const reason = previousTarget
      ? targetChangeReason(previousTarget, target)
      : 'identity-changed';
    this.pinnedSelection = cloneVisualLabSelectionIdentity(selection);
    this.pinnedTarget = cloneVisualLabRenderTarget(target);
    this.pinnedDocumentUri = documentUri;
    this.sessionState = {
      status: 'available',
      target: cloneVisualLabRenderTarget(target),
      before: changed
        ? staleSlot(this.slot('before'), reason)
        : cloneSlotState(this.slot('before')),
      after: changed
        ? staleSlot(this.slot('after'), reason)
        : cloneSlotState(this.slot('after')),
    };
    this.publish();
  }

  private setUnavailable(
    reason: VisualLabUnavailableReason,
    staleReason: VisualLabStaleReason,
  ): void {
    this.abortCaptures();
    this.sessionState = {
      status: 'unavailable',
      reason,
      ...(this.pinnedTarget
        ? { pinnedTarget: cloneVisualLabRenderTarget(this.pinnedTarget) }
        : {}),
      before: staleSlot(this.slot('before'), staleReason),
      after: staleSlot(this.slot('after'), staleReason),
    };
    this.publish();
  }

  private failActiveCapture(
    slot: VisualLabSlot,
    generation: number,
    reason: VisualLabCaptureFailureReason,
  ): void {
    if (!this.isActiveCapture(slot, generation)) return;
    this.activeCaptures.delete(slot);
    this.setSlot(slot, {
      status: 'failed',
      slot,
      requestGeneration: generation,
      reason,
      ...retainedProperty(this.slot(slot)),
    });
    this.publish();
  }

  private isActiveCapture(slot: VisualLabSlot, generation: number): boolean {
    const active = this.activeCaptures.get(slot);
    return active?.generation === generation && !active.controller.signal.aborted;
  }

  private isObsoleteSelection(operation: number): boolean {
    return this.activeSelection?.operation !== operation
      || this.activeSelection.controller.signal.aborted;
  }

  private slot(slot: VisualLabSlot): VisualLabSlotState {
    return slot === 'before'
      ? this.sessionState.before
      : this.sessionState.after;
  }

  private setSlot(slot: VisualLabSlot, state: VisualLabSlotState): void {
    this.sessionState = slot === 'before'
      ? { ...this.sessionState, before: state }
      : { ...this.sessionState, after: state };
  }

  private abortCaptures(): void {
    for (const active of this.activeCaptures.values()) {
      active.controller.abort();
    }
    this.activeCaptures.clear();
  }

  private abortSelection(): void {
    this.activeSelection?.controller.abort();
    this.activeSelection = undefined;
  }

  private publish(): void {
    const state = this.state();
    for (const listener of [...this.listeners]) listener(state);
  }
}

function emptySlot(slot: VisualLabSlot): VisualLabSlotState {
  return { status: 'empty', slot };
}

function staleSlot(
  state: VisualLabSlotState,
  reason: VisualLabStaleReason,
): VisualLabSlotState {
  const retained = retainedFrame(state);
  return retained
    ? {
        status: 'stale',
        slot: state.slot,
        reason,
        frame: cloneVisualLabFrameEvidence(retained.frame),
      }
    : emptySlot(state.slot);
}

function retainedProperty(
  state: VisualLabSlotState,
): { readonly previous?: VisualLabRetainedFrame } {
  const retained = retainedFrame(state);
  return retained ? { previous: retained } : {};
}

function retainedFrame(
  state: VisualLabSlotState,
): VisualLabRetainedFrame | undefined {
  if (state.status === 'current') {
    return {
      status: 'current',
      frame: cloneVisualLabFrameEvidence(state.frame),
    };
  }
  if (state.status === 'stale') {
    return {
      status: 'stale',
      frame: cloneVisualLabFrameEvidence(state.frame),
      staleReason: state.reason,
    };
  }
  if (state.status === 'capturing' || state.status === 'failed') {
    return state.previous
      ? {
          ...state.previous,
          frame: cloneVisualLabFrameEvidence(state.previous.frame),
        }
      : undefined;
  }
  return undefined;
}

function cloneSessionState(state: VisualLabSessionState): VisualLabSessionState {
  if (state.status === 'available') {
    return {
      status: 'available',
      target: cloneVisualLabRenderTarget(state.target),
      before: cloneSlotState(state.before),
      after: cloneSlotState(state.after),
    };
  }
  return {
    status: 'unavailable',
    reason: state.reason,
    ...(state.pinnedTarget
      ? { pinnedTarget: cloneVisualLabRenderTarget(state.pinnedTarget) }
      : {}),
    before: cloneSlotState(state.before),
    after: cloneSlotState(state.after),
  };
}

function cloneSlotState(state: VisualLabSlotState): VisualLabSlotState {
  if (state.status === 'empty') return { ...state };
  if (state.status === 'current') {
    return { ...state, frame: cloneVisualLabFrameEvidence(state.frame) };
  }
  if (state.status === 'stale') {
    return { ...state, frame: cloneVisualLabFrameEvidence(state.frame) };
  }
  return {
    ...state,
    ...(state.previous
      ? {
          previous: {
            ...state.previous,
            frame: cloneVisualLabFrameEvidence(state.previous.frame),
          },
        }
      : {}),
  };
}

function staleReasonForUnavailable(
  reason: VisualLabUnavailableReason,
): VisualLabStaleReason {
  return reason === 'adapter-disconnected' || reason === 'no-adapter'
    ? 'adapter-disconnected'
    : 'identity-changed';
}

function selectionChangeReason(
  previous: VisualLabSelectionIdentity,
  next: VisualLabSelectionIdentity,
): VisualLabStaleReason {
  if (previous.adapter.instanceId !== next.adapter.instanceId) {
    return 'adapter-instance-changed';
  }
  if (previous.selectionId !== next.selectionId) return 'selection-changed';
  if (
    previous.material.revision.assetGuid
    !== next.material.revision.assetGuid
  ) return 'material-changed';
  if (
    contextAssetKey(previous.material) !== contextAssetKey(next.material)
  ) return 'material-revision-changed';
  if (contextAssetKey(previous.source) !== contextAssetKey(next.source)) {
    return 'source-revision-changed';
  }
  if (
    visualLabSelectionKey(previous) !== visualLabSelectionKey(next)
  ) return 'shader-context-changed';
  return 'identity-changed';
}

function targetChangeReason(
  previous: VisualLabRenderTarget,
  next: VisualLabRenderTarget,
): VisualLabStaleReason {
  if (previous.adapter.instanceId !== next.adapter.instanceId) {
    return 'adapter-instance-changed';
  }
  if (previous.selectionId !== next.selectionId) return 'selection-changed';
  if (
    previous.material.revision.assetGuid
    !== next.material.revision.assetGuid
  ) return 'material-changed';
  if (contextAssetKey(previous.material) !== contextAssetKey(next.material)) {
    return 'material-revision-changed';
  }
  if (contextAssetKey(previous.source) !== contextAssetKey(next.source)) {
    return 'source-revision-changed';
  }
  if (
    shaderContextKey(previous) !== shaderContextKey(next)
  ) return 'shader-context-changed';
  if (JSON.stringify(previous.pipeline) !== JSON.stringify(next.pipeline)) {
    return 'pipeline-changed';
  }
  if (JSON.stringify(previous.profile) !== JSON.stringify(next.profile)) {
    return 'profile-changed';
  }
  if (previous.colorSpace !== next.colorSpace) return 'color-space-changed';
  if (previous.renderInputId !== next.renderInputId) {
    return 'render-input-changed';
  }
  return 'identity-changed';
}

function contextAssetKey(
  asset: VisualLabRenderTarget['material'],
): string {
  return JSON.stringify([
    asset.name,
    asset.path,
    asset.revision.uri,
    asset.revision.assetGuid,
    asset.revision.contentHash,
  ]);
}

function shaderContextKey(target: VisualLabRenderTarget): string {
  return JSON.stringify(target.shaderContext);
}
