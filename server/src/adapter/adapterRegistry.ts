import {
  ADAPTER_INTERFACE_VERSION,
  type AdapterHandshake,
  type AdapterStatus,
  type AdapterUnavailableReason,
} from '@unity-shader-nav/shared';

const DEFAULT_HANDSHAKE_MAX_AGE_MS = 30_000;

interface ConnectedAdapter {
  readonly state: 'connected';
  readonly expectedProjectId: string;
  readonly handshake: AdapterHandshake;
}

interface DisconnectedAdapter {
  readonly state: 'disconnected';
}

type RegisteredAdapter = ConnectedAdapter | DisconnectedAdapter;

export interface AdapterRegistryOptions {
  readonly now?: () => number;
  readonly handshakeMaxAgeMs?: number;
}

/**
 * Trust boundary for Adapter handshake evidence. A later transport can feed
 * this registry without exposing transport state to LSP request handlers.
 */
export class AdapterRegistry {
  private readonly now: () => number;
  private readonly handshakeMaxAgeMs: number;
  private registered: RegisteredAdapter | undefined;

  constructor(options: AdapterRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.handshakeMaxAgeMs = options.handshakeMaxAgeMs
      ?? DEFAULT_HANDSHAKE_MAX_AGE_MS;
  }

  registerHandshake(
    expectedProjectId: string,
    handshake: AdapterHandshake,
  ): AdapterStatus {
    this.registered = {
      state: 'connected',
      expectedProjectId,
      handshake: {
        ...handshake,
        capabilities: {
          ...handshake.capabilities,
          supportedFeatures: [...handshake.capabilities.supportedFeatures],
        },
      },
    };
    return this.status();
  }

  disconnect(): void {
    this.registered = { state: 'disconnected' };
  }

  status(): AdapterStatus {
    if (!this.registered) return standalone('no-adapter');
    if (this.registered.state === 'disconnected') {
      return standalone('disconnected');
    }

    const { expectedProjectId, handshake } = this.registered;
    if (handshake.interfaceVersion !== ADAPTER_INTERFACE_VERSION) {
      return standalone('version-incompatible');
    }
    if (handshake.capabilities.projectId !== expectedProjectId) {
      return standalone('foreign-project');
    }

    const age = this.now() - handshake.issuedAt;
    if (
      !Number.isFinite(handshake.issuedAt)
      || age < 0
      || age > this.handshakeMaxAgeMs
    ) {
      return standalone('stale');
    }

    return {
      mode: 'adapter',
      capabilities: handshake.capabilities,
    };
  }
}

function standalone(reason: AdapterUnavailableReason): AdapterStatus {
  return { mode: 'standalone', reason };
}
