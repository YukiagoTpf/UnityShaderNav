import {
  ADAPTER_INTERFACE_VERSION,
  SHADER_MESSAGES_CAPABILITY,
  MATERIAL_USAGES_ADAPTER_FEATURE,
  type AdapterDiagnostic,
  type AdapterHandshake,
  type AdapterStatus,
  type AdapterUnavailableReason,
  type MaterialSerializedValue,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type { ShaderMessageSource } from './shaderMessageSource';
import type {
  MaterialShaderIdentity,
  MaterialSource,
  MaterialUsageResult,
} from './materialSource';
import { unknownMaterialUsage } from './materialSource';

const DEFAULT_HANDSHAKE_MAX_AGE_MS = 30_000;

function cloneSerializedValue(value: MaterialSerializedValue): MaterialSerializedValue {
  if (Array.isArray(value)) return value.map(cloneSerializedValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        cloneSerializedValue(nested),
      ]),
    );
  }
  return value;
}

interface ConnectedAdapter {
  readonly state: 'connected';
  readonly expectedProjectId: string;
  readonly handshake: AdapterHandshake;
  readonly materialSource?: MaterialSource;
}

interface DisconnectedAdapter {
  readonly state: 'disconnected';
}

type RegisteredAdapter = ConnectedAdapter | DisconnectedAdapter;

export interface AdapterRegistryOptions {
  readonly now?: () => number;
  readonly handshakeMaxAgeMs?: number;
  readonly messageSource?: ShaderMessageSource;
}

/**
 * Trust boundary for Adapter handshake evidence. A later transport can feed
 * this registry without exposing transport state to LSP request handlers.
 */
export class AdapterRegistry {
  private readonly now: () => number;
  private readonly handshakeMaxAgeMs: number;
  private readonly messageSource: ShaderMessageSource | undefined;
  private readonly statusListeners = new Set<(status: AdapterStatus) => void>();
  private publishedStatusKey = 'standalone:no-adapter';
  private registered: RegisteredAdapter | undefined;

  constructor(options: AdapterRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.handshakeMaxAgeMs = options.handshakeMaxAgeMs
      ?? DEFAULT_HANDSHAKE_MAX_AGE_MS;
    this.messageSource = options.messageSource;
  }

  registerHandshake(
    expectedProjectId: string,
    handshake: AdapterHandshake,
    materialSource?: MaterialSource,
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
      ...(materialSource ? { materialSource } : {}),
    };
    const status = this.computeStatus();
    this.publishStatusChange(status, true);
    return status;
  }

  disconnect(): void {
    this.registered = { state: 'disconnected' };
    this.publishStatusChange(this.computeStatus(), true);
  }

  onDidChangeStatus(listener: (status: AdapterStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => { this.statusListeners.delete(listener); } };
  }

  /**
   * Return only evidence bound to the current connection, project, producer,
   * and exact saved source revision. A null result is untrusted/unavailable
   * and must never replace a newer diagnostic publication.
   */
  async shaderMessagesFor(
    documentUri: string,
    contentHash: string,
  ): Promise<readonly AdapterDiagnostic[] | null> {
    const connected = this.currentConnectedAdapter();
    if (!connected || !this.messageSource) return null;
    if (!connected.handshake.capabilities.supportedFeatures.includes(
      SHADER_MESSAGES_CAPABILITY,
    )) return null;

    const diagnostics = await this.messageSource.getShaderMessages(documentUri);
    if (this.registered !== connected || this.currentConnectedAdapter() !== connected) {
      return null;
    }
    if (!diagnostics.every((diagnostic) => this.isCurrentDiagnostic(
      diagnostic,
      connected,
      documentUri,
      contentHash,
    ))) return null;
    return diagnostics.map((diagnostic) => ({
      shaderMessage: { ...diagnostic.shaderMessage },
      provenance: {
        ...diagnostic.provenance,
        sourceRevision: { ...diagnostic.provenance.sourceRevision },
      },
    }));
  }

  status(): AdapterStatus {
    const status = this.computeStatus();
    this.publishStatusChange(status);
    return status;
  }

  private computeStatus(): AdapterStatus {
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

  private currentConnectedAdapter(): ConnectedAdapter | undefined {
    if (this.status().mode !== 'adapter') return undefined;
    return this.registered?.state === 'connected' ? this.registered : undefined;
  }

  private isCurrentDiagnostic(
    diagnostic: AdapterDiagnostic,
    connected: ConnectedAdapter,
    documentUri: string,
    contentHash: string,
  ): boolean {
    const { handshake } = connected;
    const { capabilities } = handshake;
    const { provenance } = diagnostic;
    return provenance.capability === SHADER_MESSAGES_CAPABILITY
      && provenance.projectId === capabilities.projectId
      && provenance.instanceId === handshake.instanceId
      && provenance.adapterVersion === capabilities.adapterVersion
      && provenance.unityVersion === capabilities.unityVersion
      && Number.isFinite(provenance.collectedAt)
      && provenance.collectedAt <= this.now()
      && uriKey(provenance.sourceRevision.uri) === uriKey(documentUri)
      && provenance.sourceRevision.assetGuid.length > 0
      && provenance.sourceRevision.contentHash === contentHash;
  }

  private publishStatusChange(status: AdapterStatus, force = false): void {
    const key = status.mode === 'standalone'
      ? `standalone:${status.reason}`
      : [
          'adapter',
          status.capabilities.projectId,
          status.capabilities.unityVersion,
          status.capabilities.adapterVersion,
          ...status.capabilities.supportedFeatures,
        ].join(':');
    if (!force && key === this.publishedStatusKey) return;
    this.publishedStatusKey = key;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  /** Query only through evidence that still belongs to the trusted handshake. */
  async materialsUsingShader(
    shader: MaterialShaderIdentity,
  ): Promise<MaterialUsageResult> {
    const registered = this.registered;
    const currentStatus = this.status();
    if (currentStatus.mode === 'standalone') {
      return unknownMaterialUsage(currentStatus.reason);
    }
    if (!registered || registered.state !== 'connected') {
      return unknownMaterialUsage('source-unavailable');
    }
    if (!currentStatus.capabilities.supportedFeatures.includes(
      MATERIAL_USAGES_ADAPTER_FEATURE,
    )) {
      return unknownMaterialUsage('capability-unavailable');
    }

    const source = registered.materialSource;
    if (!source) return unknownMaterialUsage('source-unavailable');
    const { expectedProjectId, handshake } = registered;
    if (
      source.identity.projectId !== expectedProjectId
      || source.identity.projectId !== handshake.capabilities.projectId
      || source.identity.instanceId !== handshake.instanceId
    ) {
      return unknownMaterialUsage('source-identity-mismatch');
    }

    let snapshot: Awaited<ReturnType<MaterialSource['materialsUsingShader']>>;
    try {
      snapshot = await source.materialsUsingShader(shader);
    } catch {
      return unknownMaterialUsage('source-unavailable');
    }

    // A disconnect or reconnect invalidates a response already in flight.
    if (this.registered !== registered) {
      const latest = this.status();
      return unknownMaterialUsage(
        latest.mode === 'standalone' ? latest.reason : 'invalid-evidence',
      );
    }
    const latest = this.status();
    if (latest.mode === 'standalone') {
      return unknownMaterialUsage(latest.reason);
    }
    if (snapshot.assetScope === 'unknown') {
      return unknownMaterialUsage(snapshot.reason);
    }
    if (
      !snapshot.revision
      || !Number.isFinite(snapshot.collectedAt)
      || snapshot.collectedAt < 0
    ) {
      return unknownMaterialUsage('invalid-evidence');
    }

    const provenance = {
      capability: MATERIAL_USAGES_ADAPTER_FEATURE,
      projectId: source.identity.projectId,
      instanceId: source.identity.instanceId,
      adapterVersion: handshake.capabilities.adapterVersion,
      unityVersion: handshake.capabilities.unityVersion,
      collectedAt: snapshot.collectedAt,
      sourceRevision: snapshot.revision,
    } as const;
    return {
      availability: 'available',
      assetScope: 'complete',
      runtimeMaterials: 'unknown',
      revision: snapshot.revision,
      materials: snapshot.materials.map((material) => ({
        guid: material.guid,
        path: material.path,
        properties: material.properties.map((property) => ({
          name: property.name,
          type: property.type,
          serializedValue: cloneSerializedValue(property.serializedValue),
        })),
        provenance,
      })),
    };
  }
}

function standalone(reason: AdapterUnavailableReason): AdapterStatus {
  return { mode: 'standalone', reason };
}
