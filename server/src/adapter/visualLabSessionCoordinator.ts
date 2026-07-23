import {
  type MaterialContextResult,
  type VisualLabSessionState,
  type VisualLabStateChangedParams,
  type VisualLabUnavailableReason,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type { WorkspaceManager } from '../workspace';
import { VisualLabRpcSource } from './ipc/visualLabRpcSource';
import { VisualLabService } from './visualLabService';
import {
  createVisualLabSelectionIdentity,
  type VisualLabSelectionResult,
} from './visualLabSource';
import type {
  WorkspaceAdapterCoordinator,
} from './workspaceAdapterCoordinator';

const MAX_VISUAL_LAB_SESSIONS = 16;

export interface VisualLabSessionCoordinatorOptions {
  readonly manager: Pick<
    WorkspaceManager,
    | 'workspaceFor'
    | 'materialContextFor'
    | 'selectedIncludePointContextFor'
  >;
  readonly adapters: Pick<
    WorkspaceAdapterCoordinator,
    | 'rpcForFolder'
    | 'stateForFolder'
    | 'onDidChangeStatus'
  >;
  readonly publish: (params: VisualLabStateChangedParams) => void;
}

interface SessionRecord {
  readonly ownerUri: string;
  readonly folderUri: string;
  readonly service: VisualLabService;
  readonly subscription: { dispose(): void };
}

/**
 * Session-only owner for URI-routed Visual Lab services. No frame, target, or
 * Material fact is written to the index, cache, global storage, or telemetry.
 */
export class VisualLabSessionCoordinator {
  private readonly records = new Map<string, SessionRecord>();
  private active: SessionRecord | undefined;
  private disposed = false;

  constructor(private readonly options: VisualLabSessionCoordinatorOptions) {}

  serviceFor(documentUri: string): VisualLabService | undefined {
    if (this.disposed) return undefined;
    const key = uriKey(documentUri);
    let record = this.records.get(key)
      ?? this.recordOwningSource(documentUri);
    if (!record) record = this.createRecord(documentUri);
    if (!record) return undefined;
    this.active = record;
    return record.service;
  }

  markSelectionChanged(folderUri?: string): void {
    for (const record of this.records.values()) {
      if (!folderUri || record.folderUri === folderUri) {
        record.service.markSelectionChanged();
      }
    }
  }

  markSourceChanged(documentUri: string): void {
    const key = uriKey(documentUri);
    for (const record of this.records.values()) {
      if (
        uriKey(record.ownerUri) === key
        || sessionOwnsSource(record.service.state(), key)
      ) record.service.markSourceChanged();
    }
  }

  markShaderContextChanged(documentUri?: string): void {
    const key = documentUri ? uriKey(documentUri) : undefined;
    for (const record of this.records.values()) {
      if (!key || uriKey(record.ownerUri) === key) {
        record.service.markShaderContextChanged();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.records.values()) this.disposeRecord(record);
    this.records.clear();
    this.active = undefined;
  }

  private createRecord(documentUri: string): SessionRecord | undefined {
    const workspace = this.options.manager.workspaceFor(documentUri);
    if (!workspace) return undefined;
    const folderUri = workspace.folderUri;
    const source = new VisualLabRpcSource(
      this.options.adapters as WorkspaceAdapterCoordinator,
      folderUri,
    );
    const service = new VisualLabService({
      source,
      selectionProvider: {
        selectedVisualLabMaterial: (requestedUri) => (
          this.selectionFor(requestedUri, folderUri)
        ),
      },
    });
    const record: SessionRecord = {
      ownerUri: documentUri,
      folderUri,
      service,
      subscription: service.onDidChange((state) => {
        if (this.active === record) {
          this.options.publish({
            textDocument: { uri: record.ownerUri },
            state,
          });
        }
      }),
    };
    this.records.set(uriKey(documentUri), record);
    this.prune();
    return record;
  }

  private async selectionFor(
    documentUri: string,
    folderUri: string,
  ): Promise<VisualLabSelectionResult> {
    const state = this.options.adapters.stateForFolder(folderUri);
    if (!state || state.status === 'unavailable') {
      return {
        availability: 'unavailable',
        reason: adapterUnavailableReason(state?.reason),
      };
    }

    const [material, selectedContext] = await Promise.all([
      this.options.manager.materialContextFor(documentUri),
      this.options.manager.selectedIncludePointContextFor(documentUri),
    ]);
    if (material.status === 'unavailable') {
      return {
        availability: 'unavailable',
        reason: materialUnavailableReason(material),
      };
    }
    const context = selectedContext?.context;
    if (!context) {
      return {
        availability: 'unavailable',
        reason: 'context-unavailable',
      };
    }
    const selection = createVisualLabSelectionIdentity(
      material.context,
      context,
      material.publicationId,
    );
    return selection
      ? { availability: 'available', selection }
      : { availability: 'unavailable', reason: 'invalid-target' };
  }

  private recordOwningSource(documentUri: string): SessionRecord | undefined {
    const key = uriKey(documentUri);
    for (const record of this.records.values()) {
      if (sessionOwnsSource(record.service.state(), key)) return record;
    }
    return undefined;
  }

  private prune(): void {
    if (this.records.size <= MAX_VISUAL_LAB_SESSIONS) return;
    for (const [key, record] of this.records) {
      if (record === this.active) continue;
      this.records.delete(key);
      this.disposeRecord(record);
      if (this.records.size <= MAX_VISUAL_LAB_SESSIONS) return;
    }
  }

  private disposeRecord(record: SessionRecord): void {
    record.subscription.dispose();
    record.service.dispose();
  }
}

function adapterUnavailableReason(
  reason: string | undefined,
): VisualLabUnavailableReason {
  return reason === 'disconnected'
    ? 'adapter-disconnected'
    : 'no-adapter';
}

function materialUnavailableReason(
  result: Extract<MaterialContextResult, { readonly status: 'unavailable' }>,
): VisualLabUnavailableReason {
  switch (result.reason) {
    case 'no-adapter':
      return 'no-adapter';
    case 'disconnected':
    case 'connection-changed':
      return 'adapter-disconnected';
    case 'capability-unavailable':
      return 'capability-unavailable';
    case 'no-selection':
      return 'no-selection';
    default:
      return 'context-unavailable';
  }
}

function sessionOwnsSource(
  state: VisualLabSessionState,
  sourceKey: string,
): boolean {
  const target = state.status === 'available'
    ? state.target
    : state.pinnedTarget;
  if (target && uriKey(target.source.revision.uri) === sourceKey) return true;
  return [state.before, state.after].some((slot) => {
    const frame = slot.status === 'current' || slot.status === 'stale'
      ? slot.frame
      : slot.status === 'capturing' || slot.status === 'failed'
        ? slot.previous?.frame
        : undefined;
    return frame
      ? uriKey(frame.target.source.revision.uri) === sourceKey
      : false;
  });
}
