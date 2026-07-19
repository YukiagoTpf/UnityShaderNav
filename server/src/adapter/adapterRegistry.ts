import {
  ADAPTER_INTERFACE_VERSION,
  SHADER_MESSAGES_CAPABILITY,
  MATERIAL_USAGES_ADAPTER_FEATURE,
  VARIANT_BUILD_EVIDENCE_CAPABILITY,
  type AdapterDiagnostic,
  type AdapterHandshake,
  type AdapterStatus,
  type AdapterUnavailableReason,
  type CompileProfile,
  type CompileProfileDiscovery,
  type CompileProfileRunResult,
  type MaterialSerializedValue,
  type VariantBuildContextEvidence,
  type VariantBuildEvidence,
  type VariantBuildEvidenceResult,
  type VariantKeywordSetBuildEvidence,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type { CompileProfileSource } from './compileProfileSource';
import type { ShaderMessageSource } from './shaderMessageSource';
import type {
  MaterialShaderIdentity,
  MaterialSource,
  MaterialUsageResult,
} from './materialSource';
import { unknownMaterialUsage } from './materialSource';
import {
  validateVariantBuildEvidence,
  type VariantBuildEvidenceSource,
} from './variantBuildEvidenceSource';

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
  readonly profileSource?: CompileProfileSource;
  readonly variantBuildSource?: VariantBuildEvidenceSource;
}

/**
 * Trust boundary for Adapter handshake evidence. A later transport can feed
 * this registry without exposing transport state to LSP request handlers.
 */
export class AdapterRegistry {
  private readonly now: () => number;
  private readonly handshakeMaxAgeMs: number;
  private readonly messageSource: ShaderMessageSource | undefined;
  private readonly profileSource: CompileProfileSource | undefined;
  private readonly variantBuildSource: VariantBuildEvidenceSource | undefined;
  private readonly statusListeners = new Set<(status: AdapterStatus) => void>();
  private publishedStatusKey = 'standalone:no-adapter';
  private registered: RegisteredAdapter | undefined;

  constructor(options: AdapterRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.handshakeMaxAgeMs = options.handshakeMaxAgeMs
      ?? DEFAULT_HANDSHAKE_MAX_AGE_MS;
    this.messageSource = options.messageSource;
    this.profileSource = options.profileSource;
    this.variantBuildSource = options.variantBuildSource;
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

  /** Discover only profiles corroborated by the current handshake. */
  async compileProfiles(): Promise<CompileProfileDiscovery> {
    const status = this.status();
    if (status.mode === 'standalone') {
      return { status: 'adapter-unavailable', reason: status.reason };
    }
    const connected = this.registered?.state === 'connected'
      ? this.registered
      : undefined;
    if (!connected || !this.profileSource) {
      return {
        status: 'adapter-unavailable',
        reason: 'profile-source-unavailable',
      };
    }

    let reported: readonly CompileProfile[];
    try {
      reported = await this.profileSource.getCompileProfiles();
    } catch {
      return {
        status: 'adapter-unavailable',
        reason: 'profile-source-unavailable',
      };
    }
    if (!Array.isArray(reported)) {
      return { status: 'adapter-unavailable', reason: 'invalid-evidence' };
    }
    if (this.registered !== connected || this.currentConnectedAdapter() !== connected) {
      const latest = this.status();
      return {
        status: 'adapter-unavailable',
        reason: latest.mode === 'standalone'
          ? latest.reason
          : 'connection-changed',
      };
    }

    const capabilities = new Set(
      connected.handshake.capabilities.supportedFeatures,
    );
    const seen = new Set<string>();
    const profiles: CompileProfile[] = [];
    for (const profile of reported) {
      if (
        !validCompileProfile(profile)
        || !capabilities.has(profile.capability)
        || seen.has(profile.name)
      ) continue;
      seen.add(profile.name);
      profiles.push({ ...profile });
    }
    return { status: 'available', profiles };
  }

  /**
   * Return only evidence bound to the current connection, project, producer,
   * selected profile, and exact saved source revision. Unsupported and
   * unavailable requests remain explicit statuses rather than empty success.
   */
  async shaderMessagesFor(
    documentUri: string,
    contentHash: string,
    selectedProfile: CompileProfile,
  ): Promise<CompileProfileRunResult> {
    const connected = this.currentConnectedAdapter();
    if (!connected) {
      const status = this.status();
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: status.mode === 'standalone'
          ? status.reason
          : 'connection-changed',
      };
    }

    const discovery = await this.compileProfiles();
    if (discovery.status === 'adapter-unavailable') {
      return {
        ...discovery,
        requestedProfile: { ...selectedProfile },
      };
    }
    if (this.registered !== connected || this.currentConnectedAdapter() !== connected) {
      const latest = this.status();
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: latest.mode === 'standalone'
          ? latest.reason
          : 'connection-changed',
      };
    }

    const profile = discovery.profiles.find((candidate) => (
      sameCompileProfile(candidate, selectedProfile)
    ));
    if (
      !profile
      || !connected.handshake.capabilities.supportedFeatures.includes(
        SHADER_MESSAGES_CAPABILITY,
      )
    ) {
      return {
        status: 'profile-not-supported',
        requestedProfile: { ...selectedProfile },
        availableProfiles: connected.handshake.capabilities.supportedFeatures.includes(
          SHADER_MESSAGES_CAPABILITY,
        ) ? discovery.profiles : [],
      };
    }
    if (!this.messageSource) {
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: 'shader-message-source-unavailable',
      };
    }

    const startedAt = this.now();
    let diagnostics: readonly AdapterDiagnostic[];
    try {
      diagnostics = await this.messageSource.getShaderMessages(
        documentUri,
        profile,
      );
    } catch {
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: 'shader-message-source-unavailable',
      };
    }
    if (!Array.isArray(diagnostics)) {
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: 'invalid-evidence',
      };
    }
    if (this.registered !== connected || this.currentConnectedAdapter() !== connected) {
      const latest = this.status();
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: latest.mode === 'standalone'
          ? latest.reason
          : 'connection-changed',
      };
    }
    if (!diagnostics.every((diagnostic) => this.isCurrentDiagnostic(
      diagnostic,
      connected,
      documentUri,
      contentHash,
    ))) {
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: 'invalid-evidence',
      };
    }
    const profiledDiagnostics = diagnostics.map((diagnostic) => ({
      shaderMessage: { ...diagnostic.shaderMessage },
      provenance: {
        ...diagnostic.provenance,
        sourceRevision: { ...diagnostic.provenance.sourceRevision },
      },
      profile: { ...profile },
    }));
    const warningCount = profiledDiagnostics.filter((diagnostic) => (
      diagnostic.shaderMessage.severity === 'warning'
    )).length;
    const errorCount = profiledDiagnostics.length - warningCount;
    return {
      status: 'completed',
      profile: { ...profile },
      durationMs: Math.max(0, this.now() - startedAt),
      success: errorCount === 0,
      warningCount,
      errorCount,
      diagnostics: profiledDiagnostics,
    };
  }

  /**
   * Accept only aggregate build evidence owned by the current Adapter, project,
   * producer versions, and exact saved Shader contents.
   */
  async variantBuildEvidenceFor(
    documentUri: string,
    contentHash: string,
  ): Promise<VariantBuildEvidenceResult> {
    const connected = this.currentConnectedAdapter();
    if (!connected) {
      const status = this.status();
      return unavailableVariantBuildEvidence(
        status.mode === 'standalone' ? status.reason : 'connection-changed',
      );
    }
    if (!connected.handshake.capabilities.supportedFeatures.includes(
      VARIANT_BUILD_EVIDENCE_CAPABILITY,
    )) return unavailableVariantBuildEvidence('capability-unavailable');
    if (!this.variantBuildSource) {
      return unavailableVariantBuildEvidence('source-unavailable');
    }

    let evidence: VariantBuildEvidence | null;
    try {
      evidence = await this.variantBuildSource.getVariantBuildEvidence(documentUri);
    } catch {
      return unavailableVariantBuildEvidence('source-unavailable');
    }
    if (this.registered !== connected || this.currentConnectedAdapter() !== connected) {
      return unavailableVariantBuildEvidence('connection-changed');
    }
    if (!evidence) return unavailableVariantBuildEvidence('source-unavailable');
    const validationFailure = validateVariantBuildEvidence(evidence);
    if (validationFailure) {
      return unavailableVariantBuildEvidence(validationFailure);
    }

    const { handshake } = connected;
    const { capabilities } = handshake;
    const { provenance } = evidence;
    if (
      provenance.capability !== VARIANT_BUILD_EVIDENCE_CAPABILITY
      || provenance.projectId !== capabilities.projectId
      || provenance.instanceId !== handshake.instanceId
      || provenance.adapterVersion !== capabilities.adapterVersion
      || provenance.unityVersion !== capabilities.unityVersion
      || !Number.isFinite(provenance.collectedAt)
      || provenance.collectedAt < 0
      || provenance.collectedAt > this.now()
    ) return unavailableVariantBuildEvidence('invalid-evidence');
    if (
      uriKey(provenance.sourceRevision.uri) !== uriKey(documentUri)
      || provenance.sourceRevision.contentHash !== contentHash
    ) return unavailableVariantBuildEvidence('source-drift');
    if (!provenance.sourceRevision.assetGuid) {
      return unavailableVariantBuildEvidence('invalid-evidence');
    }

    return {
      availability: 'available',
      evidence: cloneVariantBuildEvidence(evidence),
    };
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

function sameCompileProfile(
  left: CompileProfile,
  right: CompileProfile,
): boolean {
  return left.name === right.name
    && left.platform === right.platform
    && left.graphicsApi === right.graphicsApi
    && left.capability === right.capability;
}

function validCompileProfile(profile: unknown): profile is CompileProfile {
  if (!profile || typeof profile !== 'object') return false;
  const candidate = profile as Partial<CompileProfile>;
  return typeof candidate.name === 'string'
    && candidate.name.trim().length > 0
    && typeof candidate.platform === 'string'
    && candidate.platform.trim().length > 0
    && typeof candidate.graphicsApi === 'string'
    && candidate.graphicsApi.trim().length > 0
    && typeof candidate.capability === 'string'
    && candidate.capability.trim().length > 0;
}

function unavailableVariantBuildEvidence(
  reason: Extract<VariantBuildEvidenceResult, { availability: 'unavailable' }>['reason'],
): Extract<VariantBuildEvidenceResult, { availability: 'unavailable' }> {
  return { availability: 'unavailable', reason };
}

function cloneVariantKeywordSet(
  keywordSet: VariantKeywordSetBuildEvidence,
): VariantKeywordSetBuildEvidence {
  return {
    ...keywordSet,
    keywords: [...keywordSet.keywords],
    compileCandidates: { ...keywordSet.compileCandidates },
    kept: { ...keywordSet.kept },
  };
}

function cloneVariantContext(
  context: VariantBuildContextEvidence,
): VariantBuildContextEvidence {
  return {
    ...context,
    compileCandidates: { ...context.compileCandidates },
    kept: { ...context.kept },
    keywordSets: context.keywordSets.map(cloneVariantKeywordSet),
  };
}

function cloneVariantBuildEvidence(evidence: VariantBuildEvidence): VariantBuildEvidence {
  return {
    status: evidence.status,
    provenance: {
      ...evidence.provenance,
      sourceRevision: { ...evidence.provenance.sourceRevision },
    },
    contexts: evidence.contexts.map(cloneVariantContext),
    ...(evidence.failure ? { failure: { ...evidence.failure } } : {}),
  };
}
