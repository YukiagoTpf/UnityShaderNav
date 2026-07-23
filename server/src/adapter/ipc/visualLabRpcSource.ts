import {
  VISUAL_LAB_ADAPTER_DESCRIBE_METHOD,
  VISUAL_LAB_ADAPTER_FEATURE,
  VISUAL_LAB_ADAPTER_RENDER_METHOD,
  type VisualLabDescribeTargetRequest,
  type VisualLabRenderRequest,
} from '@unity-shader-nav/shared';
import type {
  VisualLabSource,
  VisualLabSourceInvalidationReason,
} from '../visualLabSource';
import type { AdapterRpcConnection } from './rpcConnection';
import type {
  WorkspaceAdapterCoordinator,
} from '../workspaceAdapterCoordinator';

const INVALIDATION_REASONS = new Set<VisualLabSourceInvalidationReason>([
  'pipeline-changed',
  'profile-changed',
  'color-space-changed',
  'render-input-changed',
  'adapter-instance-changed',
  'adapter-disconnected',
  'domain-reloaded',
]);

function invalidationReason(value: unknown): VisualLabSourceInvalidationReason | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const reason = (value as { readonly reason?: unknown }).reason;
  return typeof reason === 'string'
    && INVALIDATION_REASONS.has(reason as VisualLabSourceInvalidationReason)
    ? reason as VisualLabSourceInvalidationReason
    : undefined;
}

type VisualLabConnectionCoordinator = Pick<
  WorkspaceAdapterCoordinator,
  'rpcForFolder' | 'stateForFolder' | 'onDidChangeStatus'
>;

/**
 * Reconnect-safe Visual Lab transport.
 *
 * A Visual Lab service owns retained Before/After frames longer than any one
 * Editor domain or socket. Resolve the authenticated stream for every request
 * and rebind events when the per-project client reconnects.
 */
export class VisualLabRpcSource implements VisualLabSource {
  private readonly listeners = new Set<
    (reason: VisualLabSourceInvalidationReason) => void
  >();
  private statusSubscription: { dispose(): void } | undefined;
  private eventSubscription: { dispose(): void } | undefined;
  private boundConnection: AdapterRpcConnection | undefined;
  private lastState: ReturnType<
    VisualLabConnectionCoordinator['stateForFolder']
  >;

  constructor(
    private readonly coordinator: VisualLabConnectionCoordinator,
    private readonly folderUri: string,
  ) {
    this.lastState = coordinator.stateForFolder(folderUri);
  }

  async describePreviewTarget(
    request: VisualLabDescribeTargetRequest,
    cancellation?: AbortSignal,
  ): Promise<unknown> {
    return await this.connection(cancellation).request(
      VISUAL_LAB_ADAPTER_FEATURE,
      VISUAL_LAB_ADAPTER_DESCRIBE_METHOD,
      request,
      cancellation,
    );
  }

  async renderPreview(
    request: VisualLabRenderRequest,
    cancellation?: AbortSignal,
  ): Promise<unknown> {
    return await this.connection(cancellation).request(
      VISUAL_LAB_ADAPTER_FEATURE,
      VISUAL_LAB_ADAPTER_RENDER_METHOD,
      request,
      cancellation,
    );
  }

  onDidInvalidate(
    listener: (reason: VisualLabSourceInvalidationReason) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.startObserving();
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) this.stopObserving();
      },
    };
  }

  private connection(cancellation?: AbortSignal): AdapterRpcConnection {
    if (cancellation?.aborted) {
      const reason = cancellation.reason;
      throw reason instanceof Error ? reason : new Error('cancelled');
    }
    const connection = this.coordinator.rpcForFolder(this.folderUri);
    if (!connection) throw new Error('Visual Lab Adapter is disconnected');
    return connection;
  }

  private startObserving(): void {
    this.lastState = this.coordinator.stateForFolder(this.folderUri);
    this.bindConnection(this.coordinator.rpcForFolder(this.folderUri));
    this.statusSubscription = this.coordinator.onDidChangeStatus(() => {
      this.handleConnectionChange();
    });
  }

  private stopObserving(): void {
    this.statusSubscription?.dispose();
    this.statusSubscription = undefined;
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;
    this.boundConnection = undefined;
  }

  private handleConnectionChange(): void {
    const previous = this.lastState;
    const current = this.coordinator.stateForFolder(this.folderUri);
    const connection = this.coordinator.rpcForFolder(this.folderUri);
    this.bindConnection(connection);
    this.lastState = current;

    if (previous?.status === 'connected' && current?.status !== 'connected') {
      this.publish('adapter-disconnected');
      return;
    }
    if (current?.status !== 'connected') return;
    if (
      previous?.status === 'connected'
      && previous.instanceId !== current.instanceId
    ) {
      this.publish('adapter-instance-changed');
      return;
    }
    if (previous?.status !== 'connected') {
      this.publish('render-input-changed');
    }
  }

  private bindConnection(
    connection: AdapterRpcConnection | undefined,
  ): void {
    if (this.boundConnection === connection) return;
    this.eventSubscription?.dispose();
    this.boundConnection = connection;
    this.eventSubscription = connection?.onDidReceiveEvent((event) => {
      if (
        event.capability !== VISUAL_LAB_ADAPTER_FEATURE
        || event.event !== 'target-changed'
      ) return;
      const reason = invalidationReason(event.payload);
      if (reason) this.publish(reason);
    });
  }

  private publish(reason: VisualLabSourceInvalidationReason): void {
    for (const listener of [...this.listeners]) listener(reason);
  }
}
