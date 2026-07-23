import type {
  AdapterHandshake,
  AdapterUnavailableReason,
} from '@unity-shader-nav/shared';
import type {
  AdapterConnectionSources,
} from '../adapterRegistry';
import { MaterialContextRpcSource } from './materialContextRpcSource';
import type {
  AdapterCapabilityDescriptor,
  AdapterSessionDescriptor,
} from './protocol';
import {
  AdapterConnectionError,
  AdapterRpcConnection,
} from './rpcConnection';
import {
  discoverAdapterSession,
  type AdapterDescriptorDiscovery,
} from './sessionDescriptor';

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_CAP_MS = 30_000;

export interface AdapterLifecycleRegistry {
  registerHandshake(
    expectedProjectId: string,
    handshake: AdapterHandshake,
    sources?: AdapterConnectionSources,
  ): unknown;
  disconnect(): void;
}

export type UnityAdapterClientState =
  | {
      readonly status: 'unavailable';
      readonly reason: AdapterUnavailableReason;
    }
  | {
      readonly status: 'connected';
      readonly projectHash: string;
      readonly instanceId: string;
      readonly adapterVersion: string;
      readonly unityVersion: string;
      readonly capabilities: readonly AdapterCapabilityDescriptor[];
    };

export interface UnityAdapterClientOptions {
  readonly unityRoot: string;
  /**
   * This registry is an exclusive per-Unity-root trust boundary. Sharing one
   * registry between clients would let one root replace/disconnect another.
   */
  readonly registry: AdapterLifecycleRegistry;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly reconnectBaseMs?: number;
  readonly reconnectCapMs?: number;
  readonly discover?: (unityRoot: string) => Promise<AdapterDescriptorDiscovery>;
  readonly connect?: (
    descriptor: AdapterSessionDescriptor,
  ) => Promise<AdapterRpcConnection>;
}

/**
 * Per-Unity-root Adapter lifecycle. Discovery/connect failures are additive:
 * they never block or mutate the index lifecycle owned elsewhere.
 */
export class UnityAdapterClient {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectCapMs: number;
  private readonly discover: (
    unityRoot: string,
  ) => Promise<AdapterDescriptorDiscovery>;
  private readonly connect: (
    descriptor: AdapterSessionDescriptor,
  ) => Promise<AdapterRpcConnection>;
  private readonly listeners = new Set<(state: UnityAdapterClientState) => void>();
  private stateValue: UnityAdapterClientState = {
    status: 'unavailable',
    reason: 'no-adapter',
  };
  private connection: AdapterRpcConnection | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt: Promise<void> | undefined;
  private running = false;
  private connectedOnce = false;
  private reconnectDelayMs: number;

  constructor(private readonly options: UnityAdapterClientOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.reconnectBaseMs = options.reconnectBaseMs
      ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectCapMs = options.reconnectCapMs
      ?? DEFAULT_RECONNECT_CAP_MS;
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.discover = options.discover ?? discoverAdapterSession;
    this.connect = options.connect ?? AdapterRpcConnection.connect;
  }

  get state(): UnityAdapterClientState {
    return this.stateValue;
  }

  get rpc(): AdapterRpcConnection | undefined {
    return this.connection;
  }

  onDidChangeState(
    listener: (state: UnityAdapterClientState) => void,
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  async start(): Promise<void> {
    if (this.running) return this.attempt;
    this.running = true;
    await this.tryConnect();
  }

  async refresh(): Promise<void> {
    if (!this.running || this.connection) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectDelayMs = this.reconnectBaseMs;
    await this.tryConnect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const connection = this.connection;
    this.connection = undefined;
    connection?.close();
    if (this.connectedOnce) this.options.registry.disconnect();
    this.publish({ status: 'unavailable', reason: 'disconnected' });
  }

  private async tryConnect(): Promise<void> {
    if (!this.running) return;
    if (this.attempt) return this.attempt;
    const attempt = this.connectOnce();
    this.attempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }

  private async connectOnce(): Promise<void> {
    const discovery = await this.discover(this.options.unityRoot);
    if (!this.running) return;
    if (discovery.status === 'unavailable') {
      this.publish({
        status: 'unavailable',
        reason: discoveryReason(discovery.reason),
      });
      this.scheduleReconnect();
      return;
    }

    let connection: AdapterRpcConnection;
    try {
      connection = await this.connect(discovery.descriptor);
    } catch (error) {
      this.publish({
        status: 'unavailable',
        reason: connectionReason(error),
      });
      this.scheduleReconnect();
      return;
    }
    if (!this.running) {
      connection.close();
      return;
    }

    const welcome = connection.handshake;
    const materialContext = welcome.capabilities.some(
      (capability) => capability.name === 'material-context',
    )
      ? new MaterialContextRpcSource(
          {
            projectId: welcome.projectHash,
            instanceId: welcome.instanceId,
          },
          connection,
        )
      : undefined;
    const handshake: AdapterHandshake = {
      interfaceVersion: welcome.protocolVersion,
      issuedAt: this.now(),
      instanceId: welcome.instanceId,
      capabilities: {
        unityVersion: welcome.unityVersion,
        projectId: welcome.projectHash,
        adapterVersion: welcome.adapterVersion,
        supportedFeatures: welcome.capabilities.map(({ name }) => name),
      },
    };
    this.options.registry.registerHandshake(
      welcome.projectHash,
      handshake,
      materialContext ? { materialContext } : {},
    );
    this.connection = connection;
    this.connectedOnce = true;
    this.reconnectDelayMs = this.reconnectBaseMs;
    this.publish({
      status: 'connected',
      projectHash: welcome.projectHash,
      instanceId: welcome.instanceId,
      adapterVersion: welcome.adapterVersion,
      unityVersion: welcome.unityVersion,
      capabilities: welcome.capabilities.map((entry) => ({ ...entry })),
    });
    connection.onDidClose(() => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      if (!this.running) return;
      this.options.registry.disconnect();
      this.publish({ status: 'unavailable', reason: 'disconnected' });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer || this.connection) return;
    const jitter = 0.8 + Math.max(0, Math.min(1, this.random())) * 0.4;
    const delay = Math.round(this.reconnectDelayMs * jitter);
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.reconnectCapMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.tryConnect();
    }, delay);
  }

  private publish(state: UnityAdapterClientState): void {
    if (stateKey(state) === stateKey(this.stateValue)) return;
    this.stateValue = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}

function discoveryReason(
  reason: AdapterDescriptorDiscovery extends infer Discovery
    ? Discovery extends { readonly status: 'unavailable'; readonly reason: infer R }
      ? R
      : never
    : never,
): AdapterUnavailableReason {
  switch (reason) {
    case 'foreign-project':
      return 'foreign-project';
    case 'version-incompatible':
      return 'version-incompatible';
    case 'invalid':
      return 'stale';
    case 'missing':
      return 'no-adapter';
  }
}

function connectionReason(error: unknown): AdapterUnavailableReason {
  if (error instanceof AdapterConnectionError) {
    if (error.code === 'project') return 'foreign-project';
    if (error.code === 'protocol') return 'version-incompatible';
  }
  return 'stale';
}

function stateKey(state: UnityAdapterClientState): string {
  return state.status === 'connected'
    ? [
        state.status,
        state.projectHash,
        state.instanceId,
        state.adapterVersion,
        state.unityVersion,
        state.capabilities.map(({ name, version }) => `${name}@${version}`).join(','),
      ].join(':')
    : `${state.status}:${state.reason}`;
}
