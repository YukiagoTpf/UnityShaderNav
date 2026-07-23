import { createHash } from 'node:crypto';
import {
  ADAPTER_INTERFACE_VERSION,
  COMPILER_EVIDENCE_CAPABILITY,
  SHADER_MESSAGES_CAPABILITY,
  MATERIAL_USAGES_ADAPTER_FEATURE,
  VARIANT_BUILD_EVIDENCE_CAPABILITY,
  SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
  MATERIAL_CONTEXT_ADAPTER_FEATURE,
  CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
  type AdapterCompilerEvidence,
  type AdapterDiagnostic,
  type AdapterHandshake,
  type AdapterStatus,
  type AdapterUnavailableReason,
  type CompileProfile,
  type CompileProfileDiscovery,
  type CompileProfileRunResult,
  type CompilerEvidenceRunResult,
  type CSharpPropertyUsage,
  type CSharpPropertyCallKind,
  type CSharpPropertyAccessor,
  type CSharpPropertyNameOrigin,
  type CSharpExpressionDeterminism,
  type CSharpBindingDeterminism,
  type CSharpShaderIdentity,
  type ShaderLabPropertyType,
  type Range,
  type IncludePointContext,
  type MaterialSerializedValue,
  type VariantBuildContextEvidence,
  type VariantBuildEvidence,
  type VariantBuildEvidenceResult,
  type VariantKeywordSetBuildEvidence,
  type SelectedMaterialContext,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';
import type { CompilerEvidenceSource } from './compilerEvidenceSource';
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
import type {
  ShaderGraphSource,
  ShaderGraphUsageResult,
} from './shaderGraphSource';
import {
  cloneShaderGraphNode,
  unknownShaderGraphUsage,
  validShaderGraphSnapshot,
} from './shaderGraphSource';
import type {
  MaterialContextSource,
  MaterialContextSourceSnapshot,
  TrustedMaterialContextResult,
} from './materialContextSource';
import { unknownMaterialContext } from './materialContextSource';
import type {
  AdapterCSharpPropertyUsage,
  CSharpPropertySource,
  CSharpPropertyTarget,
  CSharpPropertyUsageResult,
} from './csharpPropertySource';
import { unknownCSharpPropertyUsage } from './csharpPropertySource';

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
  readonly shaderGraphSource?: ShaderGraphSource;
  readonly materialContextSource?: MaterialContextSource;
  readonly csharpPropertySource?: CSharpPropertySource;
  readonly materialContextSubscription?: { dispose(): void };
}

interface DisconnectedAdapter {
  readonly state: 'disconnected';
}

type RegisteredAdapter = ConnectedAdapter | DisconnectedAdapter;

/** Feature transports negotiated by one handshake, extensible without positional arguments. */
export interface AdapterFeatureSources {
  readonly materialUsages?: MaterialSource;
  readonly shaderGraph?: ShaderGraphSource;
  readonly materialContext?: MaterialContextSource;
  readonly csharpPropertyUsages?: CSharpPropertySource;
}

export interface AdapterRegistryOptions {
  readonly now?: () => number;
  readonly handshakeMaxAgeMs?: number;
  readonly messageSource?: ShaderMessageSource;
  readonly profileSource?: CompileProfileSource;
  readonly variantBuildSource?: VariantBuildEvidenceSource;
  readonly compilerEvidenceSource?: CompilerEvidenceSource;
}

/** Feature payload boundaries attached atomically to one handshake instance. */
export type AdapterConnectionSources = AdapterFeatureSources;

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
  private readonly compilerEvidenceSource: CompilerEvidenceSource | undefined;
  private readonly statusListeners = new Set<(status: AdapterStatus) => void>();
  private publishedStatusKey = 'standalone:no-adapter';
  private registered: RegisteredAdapter | undefined;
  private readonly materialContextListeners = new Set<() => void>();
  private materialContextGeneration = 0;

  constructor(options: AdapterRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.handshakeMaxAgeMs = options.handshakeMaxAgeMs
      ?? DEFAULT_HANDSHAKE_MAX_AGE_MS;
    this.messageSource = options.messageSource;
    this.profileSource = options.profileSource;
    this.variantBuildSource = options.variantBuildSource;
    this.compilerEvidenceSource = options.compilerEvidenceSource;
  }

  registerHandshake(
    expectedProjectId: string,
    handshake: AdapterHandshake,
    sources: AdapterConnectionSources | MaterialSource = {},
  ): AdapterStatus {
    // Keep the pre-#101 MaterialSource argument compatible while all new
    // capabilities use the extensible source bag.
    const materialSource = 'materialsUsingShader' in sources
      ? sources
      : sources.materialUsages;
    const shaderGraphSource = 'materialsUsingShader' in sources
      ? undefined
      : sources.shaderGraph;
    const materialContextSource = 'materialsUsingShader' in sources
      ? undefined
      : sources.materialContext;
    const csharpPropertySource = 'materialsUsingShader' in sources
      ? undefined
      : sources.csharpPropertyUsages;
    this.disposeMaterialContextSubscription();
    this.materialContextGeneration++;
    const materialContextSubscription = materialContextSource?.onDidChangeSelection?.(
      () => {
        if (
          this.registered?.state !== 'connected'
          || this.registered.materialContextSource !== materialContextSource
        ) return;
        this.materialContextGeneration++;
        this.publishMaterialContextChange();
      },
    );
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
      ...(shaderGraphSource ? { shaderGraphSource } : {}),
      ...(materialContextSource ? { materialContextSource } : {}),
      ...(csharpPropertySource ? { csharpPropertySource } : {}),
      ...(materialContextSubscription ? { materialContextSubscription } : {}),
    };
    const status = this.computeStatus();
    this.publishStatusChange(status, true);
    this.publishMaterialContextChange();
    return status;
  }

  disconnect(): void {
    this.disposeMaterialContextSubscription();
    this.materialContextGeneration++;
    this.registered = { state: 'disconnected' };
    this.publishStatusChange(this.computeStatus(), true);
    this.publishMaterialContextChange();
  }

  onDidChangeMaterialContext(listener: () => void): { dispose(): void } {
    this.materialContextListeners.add(listener);
    return { dispose: () => { this.materialContextListeners.delete(listener); } };
  }

  onDidChangeStatus(listener: (status: AdapterStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => { this.statusListeners.delete(listener); } };
  }

  /** Discover only profiles corroborated by the current handshake. */
  async compileProfiles(cancellation?: AbortSignal): Promise<CompileProfileDiscovery> {
    if (cancellation?.aborted) {
      return { status: 'adapter-unavailable', reason: 'analysis-cancelled' };
    }
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
      reported = await this.profileSource.getCompileProfiles(cancellation);
    } catch {
      return {
        status: 'adapter-unavailable',
        reason: cancellation?.aborted
          ? 'analysis-cancelled'
          : 'profile-source-unavailable',
      };
    }
    if (cancellation?.aborted) {
      return { status: 'adapter-unavailable', reason: 'analysis-cancelled' };
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
    cancellation?: AbortSignal,
  ): Promise<CompileProfileRunResult> {
    if (cancellation?.aborted) {
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: 'analysis-cancelled',
      };
    }
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

    const discovery = await this.compileProfiles(cancellation);
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
        cancellation,
      );
    } catch {
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: cancellation?.aborted
          ? 'analysis-cancelled'
          : 'shader-message-source-unavailable',
      };
    }
    if (cancellation?.aborted) {
      return {
        status: 'adapter-unavailable',
        requestedProfile: { ...selectedProfile },
        reason: 'analysis-cancelled',
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

  /**
   * Return compiler texts only when their Context, profile, producer, project,
   * connection, and exact owning Shader revision all still match.
   */
  async compilerEvidenceFor(
    context: IncludePointContext,
    contentHash: string,
    selectedProfile: CompileProfile,
  ): Promise<CompilerEvidenceRunResult> {
    const connected = this.currentConnectedAdapter();
    if (!connected) {
      const status = this.status();
      return {
        status: 'unavailable',
        reason: status.mode === 'standalone'
          ? status.reason
          : 'connection-changed',
      };
    }

    const discovery = await this.compileProfiles();
    if (discovery.status === 'adapter-unavailable') {
      return { status: 'unavailable', reason: discovery.reason };
    }
    if (this.registered !== connected || this.currentConnectedAdapter() !== connected) {
      const latest = this.status();
      return {
        status: 'unavailable',
        reason: latest.mode === 'standalone'
          ? latest.reason
          : 'connection-changed',
      };
    }

    const profile = discovery.profiles.find((candidate) => (
      sameCompileProfile(candidate, selectedProfile)
    ));
    if (!profile) return { status: 'unavailable', reason: 'profile-not-supported' };
    if (!connected.handshake.capabilities.supportedFeatures.includes(
      COMPILER_EVIDENCE_CAPABILITY,
    )) {
      return { status: 'unavailable', reason: 'capability-unavailable' };
    }
    if (!this.compilerEvidenceSource) {
      return {
        status: 'unavailable',
        reason: 'compiler-evidence-source-unavailable',
      };
    }

    let evidence: AdapterCompilerEvidence;
    try {
      evidence = await this.compilerEvidenceSource.getCompilerEvidence(
        cloneIncludePointContext(context),
        { ...profile },
      );
    } catch {
      return {
        status: 'unavailable',
        reason: 'compiler-evidence-source-unavailable',
      };
    }
    if (this.registered !== connected || this.currentConnectedAdapter() !== connected) {
      const latest = this.status();
      return {
        status: 'unavailable',
        reason: latest.mode === 'standalone'
          ? latest.reason
          : 'connection-changed',
      };
    }
    let valid = false;
    try {
      valid = this.isCurrentCompilerEvidence(
        evidence,
        connected,
        context,
        contentHash,
        profile,
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      return { status: 'unavailable', reason: 'invalid-evidence' };
    }

    return { status: 'available', evidence: cloneCompilerEvidence(evidence) };
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

  private isCurrentCompilerEvidence(
    evidence: AdapterCompilerEvidence,
    connected: ConnectedAdapter,
    context: IncludePointContext,
    contentHash: string,
    profile: CompileProfile,
  ): boolean {
    if (!evidence || typeof evidence !== 'object') return false;
    if (!Array.isArray(evidence.sources) || !Array.isArray(evidence.documents)) return false;
    const { handshake } = connected;
    const { capabilities } = handshake;
    const { provenance } = evidence;
    if (
      !provenance
      || provenance.capability !== COMPILER_EVIDENCE_CAPABILITY
      || provenance.projectId !== capabilities.projectId
      || provenance.instanceId !== handshake.instanceId
      || provenance.adapterVersion !== capabilities.adapterVersion
      || provenance.unityVersion !== capabilities.unityVersion
      || provenance.contextId !== context.id
      || !sameCompileProfile(provenance.profile, profile)
      || !Number.isFinite(provenance.collectedAt)
      || provenance.collectedAt < 0
      || provenance.collectedAt > this.now()
      || uriKey(provenance.sourceRevision.uri) !== uriKey(context.shaderUri)
      || provenance.sourceRevision.contentHash !== contentHash
      || provenance.sourceRevision.assetGuid.length === 0
    ) return false;

    const sourceKeys = new Set<string>();
    let owningSourceFound = false;
    for (const source of evidence.sources) {
      if (
        !source
        || typeof source.text !== 'string'
        || !Array.isArray(source.lineDirectiveNames)
        || source.lineDirectiveNames.some((name: unknown) => (
          typeof name !== 'string' || name.length === 0
        ))
        || new Set(source.lineDirectiveNames).size !== source.lineDirectiveNames.length
        || typeof source.identity?.uri !== 'string'
        || typeof source.identity?.sourceId !== 'string'
        || source.identity.sourceId.length === 0
        || !isSha256(source.identity.contentHash)
        || sha256(source.text) !== source.identity.contentHash
      ) return false;
      const key = uriKey(source.identity.uri);
      if (sourceKeys.has(key)) return false;
      sourceKeys.add(key);
      if (key === uriKey(context.shaderUri)) {
        if (
          source.identity.contentHash !== contentHash
          || source.identity.sourceId !== provenance.sourceRevision.assetGuid
        ) return false;
        owningSourceFound = true;
      }
    }
    if (!owningSourceFound) return false;

    const kinds = new Set<string>();
    for (const document of evidence.documents) {
      if (
        !document
        || (document.kind !== 'preprocessed' && document.kind !== 'generated')
        || typeof document.text !== 'string'
        || (document.compilerPath !== undefined && (
          typeof document.compilerPath !== 'string'
          || document.compilerPath.length === 0
        ))
        || kinds.has(document.kind)
      ) return false;
      kinds.add(document.kind);
    }
    return kinds.has('preprocessed') && kinds.has('generated');
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

  /**
   * Return only connection-bound, source-revision-validated C# property
   * usages. The trust boundary validates the provenance envelope plus each
   * usage's exact C# source revision (URI + content hash); a single opaque
   * snapshot revision is insufficient to rule out stale C# positions. Every
   * usage field is structurally validated, and a usage whose propertyName or
   * shader identity does not exactly match the requested target is dropped as
   * a foreign target. The raw payload may include name-only or dynamic items
   * for explicit rejection testing — authoritative filtering happens in the
   * Workspace overlay, not here.
   */
  async csharpPropertyUsagesFor(
    target: CSharpPropertyTarget,
  ): Promise<CSharpPropertyUsageResult> {
    const registered = this.registered;
    const currentStatus = this.status();
    if (currentStatus.mode === 'standalone') {
      return unknownCSharpPropertyUsage(currentStatus.reason);
    }
    if (!registered || registered.state !== 'connected') {
      return unknownCSharpPropertyUsage('source-unavailable');
    }
    if (!currentStatus.capabilities.supportedFeatures.includes(
      CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
    )) {
      return unknownCSharpPropertyUsage('capability-unavailable');
    }

    const source = registered.csharpPropertySource;
    if (!source) return unknownCSharpPropertyUsage('source-unavailable');
    const { expectedProjectId, handshake } = registered;
    if (
      source.identity.projectId !== expectedProjectId
      || source.identity.projectId !== handshake.capabilities.projectId
      || source.identity.instanceId !== handshake.instanceId
    ) {
      return unknownCSharpPropertyUsage('source-identity-mismatch');
    }

    let snapshot: Awaited<ReturnType<CSharpPropertySource['csharpPropertyUsagesFor']>>;
    try {
      snapshot = await source.csharpPropertyUsagesFor(target);
    } catch {
      return unknownCSharpPropertyUsage('source-unavailable');
    }

    // A disconnect or reconnect invalidates a response already in flight.
    if (this.registered !== registered) {
      const latest = this.status();
      return unknownCSharpPropertyUsage(
        latest.mode === 'standalone' ? latest.reason : 'invalid-evidence',
      );
    }
    const latest = this.status();
    if (latest.mode === 'standalone') {
      return unknownCSharpPropertyUsage(latest.reason);
    }
    if (snapshot.assetScope === 'unknown') {
      return unknownCSharpPropertyUsage(snapshot.reason);
    }
    if (
      !snapshot.revision
      || !Number.isFinite(snapshot.collectedAt)
      || snapshot.collectedAt < 0
    ) {
      return unknownCSharpPropertyUsage('invalid-evidence');
    }

    const provenanceBase = {
      capability: CSHARP_PROPERTY_USAGES_ADAPTER_FEATURE,
      projectId: source.identity.projectId,
      instanceId: source.identity.instanceId,
      adapterVersion: handshake.capabilities.adapterVersion,
      unityVersion: handshake.capabilities.unityVersion,
      collectedAt: snapshot.collectedAt,
      sourceRevision: snapshot.revision,
    } as const;

    const usages: CSharpPropertyUsage[] = [];
    for (const usage of snapshot.usages) {
      if (!validCSharpPropertyUsage(usage, target)) continue;
      usages.push({
        ...usage,
        shader: usage.shader ? { ...usage.shader } : null,
        sourceRevision: { ...usage.sourceRevision },
        provenance: provenanceBase,
      });
    }

    return {
      availability: 'available',
      assetScope: 'complete',
      revision: snapshot.revision,
      usages,
    };
  }

  /** Return only complete, connection-bound logical Shader Graph facts. */
  async shaderGraphCustomFunctions(): Promise<ShaderGraphUsageResult> {
    const registered = this.registered;
    const currentStatus = this.status();
    if (currentStatus.mode === 'standalone') {
      return unknownShaderGraphUsage(currentStatus.reason);
    }
    if (!registered || registered.state !== 'connected') {
      return unknownShaderGraphUsage('source-unavailable');
    }
    if (!currentStatus.capabilities.supportedFeatures.includes(
      SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
    )) {
      return unknownShaderGraphUsage('capability-unavailable');
    }

    const source = registered.shaderGraphSource;
    if (!source) return unknownShaderGraphUsage('source-unavailable');
    const { expectedProjectId, handshake } = registered;
    if (
      source.identity.projectId !== expectedProjectId
      || source.identity.projectId !== handshake.capabilities.projectId
      || source.identity.instanceId !== handshake.instanceId
    ) {
      return unknownShaderGraphUsage('source-identity-mismatch');
    }

    let snapshot: Awaited<ReturnType<ShaderGraphSource['customFunctionNodes']>>;
    try {
      snapshot = await source.customFunctionNodes();
    } catch {
      return unknownShaderGraphUsage('source-unavailable');
    }
    if (this.registered !== registered) {
      const latest = this.status();
      return unknownShaderGraphUsage(
        latest.mode === 'standalone' ? latest.reason : 'connection-changed',
      );
    }
    const latest = this.status();
    if (latest.mode === 'standalone') {
      return unknownShaderGraphUsage(latest.reason);
    }
    if (
      !snapshot
      || typeof snapshot !== 'object'
      || !validNonEmptyString(snapshot.shaderGraphVersion)
    ) {
      return unknownShaderGraphUsage('invalid-evidence');
    }
    if (snapshot.status === 'unsupported-version') {
      return unknownShaderGraphUsage(
        'shader-graph-version-unsupported',
        snapshot.shaderGraphVersion,
      );
    }
    if (!validShaderGraphSnapshot(snapshot, this.now())) {
      return unknownShaderGraphUsage('invalid-evidence');
    }

    const provenanceBase = {
      capability: SHADER_GRAPH_CUSTOM_FUNCTIONS_CAPABILITY,
      projectId: source.identity.projectId,
      instanceId: source.identity.instanceId,
      adapterVersion: handshake.capabilities.adapterVersion,
      unityVersion: handshake.capabilities.unityVersion,
      collectedAt: snapshot.collectedAt,
      shaderGraphVersion: snapshot.shaderGraphVersion,
    } as const;
    return {
      availability: 'available',
      assetScope: 'complete',
      shaderGraphVersion: snapshot.shaderGraphVersion,
      revision: snapshot.revision,
      usages: snapshot.assets.flatMap((asset) => asset.nodes.map((node) => ({
        ...cloneShaderGraphNode(node),
        provenance: {
          ...provenanceBase,
          sourceRevision: { ...asset.sourceRevision },
        },
      }))),
    };
  }

  async selectedMaterialContext(): Promise<TrustedMaterialContextResult> {
    const registered = this.registered;
    const currentStatus = this.status();
    if (currentStatus.mode === 'standalone') {
      return unknownMaterialContext(currentStatus.reason);
    }
    if (!registered || registered.state !== 'connected') {
      return unknownMaterialContext('source-unavailable');
    }
    if (!currentStatus.capabilities.supportedFeatures.includes(
      MATERIAL_CONTEXT_ADAPTER_FEATURE,
    )) {
      return unknownMaterialContext('capability-unavailable');
    }

    const source = registered.materialContextSource;
    if (!source) return unknownMaterialContext('source-unavailable');
    const { expectedProjectId, handshake } = registered;
    if (
      source.identity.projectId !== expectedProjectId
      || source.identity.projectId !== handshake.capabilities.projectId
      || source.identity.instanceId !== handshake.instanceId
    ) {
      return unknownMaterialContext('source-identity-mismatch');
    }

    const generation = this.materialContextGeneration;
    let snapshot: unknown;
    try {
      snapshot = await source.selectedMaterialContext();
    } catch {
      return unknownMaterialContext('source-unavailable');
    }
    if (this.registered !== registered) {
      return unknownMaterialContext('connection-changed');
    }
    if (generation !== this.materialContextGeneration) {
      return unknownMaterialContext('selection-changed');
    }
    if (this.status().mode === 'standalone') {
      return unknownMaterialContext('connection-changed');
    }
    if (isNoMaterialSelection(snapshot)) {
      return unknownMaterialContext('no-selection');
    }
    if (!validMaterialContextSnapshot(snapshot, this.now())) {
      return unknownMaterialContext('invalid-evidence');
    }

    const context: SelectedMaterialContext = {
      selectionId: snapshot.selectionId,
      material: cloneContextAsset(snapshot.material),
      shader: cloneContextAsset(snapshot.shader),
      ...(snapshot.selectedProgram
        ? { selectedProgram: { ...snapshot.selectedProgram } }
        : {}),
      properties: snapshot.properties.map((property) => ({
        name: property.name,
        type: property.type,
        serializedValue: cloneSerializedValue(property.serializedValue),
      })),
      textures: snapshot.textures.map((binding) => ({
        propertyName: binding.propertyName,
        texture: binding.texture ? { ...binding.texture } : null,
      })),
      keywords: {
        material: snapshot.materialKeywords.map((keyword) => ({ ...keyword })),
        global: { status: 'unknown', reason: 'draw-evidence-required' },
        engineAdded: { status: 'unknown', reason: 'draw-evidence-required' },
      },
      provenance: {
        capability: MATERIAL_CONTEXT_ADAPTER_FEATURE,
        projectId: source.identity.projectId,
        instanceId: source.identity.instanceId,
        adapterVersion: handshake.capabilities.adapterVersion,
        unityVersion: handshake.capabilities.unityVersion,
        collectedAt: snapshot.collectedAt,
        sourceRevision: snapshot.selectionId,
      },
    };
    return { availability: 'available', context };
  }

  private disposeMaterialContextSubscription(): void {
    if (this.registered?.state === 'connected') {
      this.registered.materialContextSubscription?.dispose();
    }
  }

  private publishMaterialContextChange(): void {
    for (const listener of [...this.materialContextListeners]) listener();
  }
}

function cloneContextAsset(
  asset: import('@unity-shader-nav/shared').MaterialContextAsset,
): import('@unity-shader-nav/shared').MaterialContextAsset {
  return { ...asset, revision: { ...asset.revision } };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validAssetGuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validAsset(asset: unknown): boolean {
  if (!isRecord(asset) || !isRecord(asset.revision)) return false;
  return nonEmptyString(asset.name)
    && nonEmptyString(asset.path)
    && nonEmptyString(asset.revision.uri)
    && validAssetGuid(asset.revision.assetGuid)
    && nonEmptyString(asset.revision.contentHash);
}

function validSerializedValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set(),
): boolean {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  const nestedAncestors = new Set(ancestors);
  nestedAncestors.add(value);
  return Array.isArray(value)
    ? value.every((nested) => validSerializedValue(nested, nestedAncestors))
    : Object.values(value).every((nested) => (
      validSerializedValue(nested, nestedAncestors)
    ));
}

function validSelectedProgram(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.subShaderIndex)
    && Number(value.subShaderIndex) >= 0
    && (
      value.passIndex === undefined
      || (Number.isSafeInteger(value.passIndex) && Number(value.passIndex) >= 0)
    )
    && (value.passName === undefined || nonEmptyString(value.passName));
}

function validProperty(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.name)
    && ['float', 'integer', 'vector', 'texture'].includes(String(value.type))
    && validSerializedValue(value.serializedValue);
}

function validTexture(value: unknown): boolean {
  if (!isRecord(value) || !nonEmptyString(value.propertyName)) return false;
  return value.texture === null
    || (
      isRecord(value.texture)
      && nonEmptyString(value.texture.name)
      && validAssetGuid(value.texture.guid)
      && nonEmptyString(value.texture.path)
    );
}

function validKeyword(value: unknown): boolean {
  return isRecord(value)
    && nonEmptyString(value.name)
    && typeof value.enabled === 'boolean'
    && (value.scope === 'local' || value.scope === 'legacy');
}

function isNoMaterialSelection(snapshot: unknown): boolean {
  return isRecord(snapshot) && snapshot.status === 'none';
}

function validMaterialContextSnapshot(
  snapshot: unknown,
  now: number,
): snapshot is Extract<
  MaterialContextSourceSnapshot,
  { readonly status: 'selected' }
> {
  if (!isRecord(snapshot)) return false;
  return snapshot.status === 'selected'
    && nonEmptyString(snapshot.selectionId)
    && Number.isFinite(snapshot.collectedAt)
    && Number(snapshot.collectedAt) >= 0
    && Number(snapshot.collectedAt) <= now
    && validAsset(snapshot.material)
    && validAsset(snapshot.shader)
    && (
      snapshot.selectedProgram === undefined
      || validSelectedProgram(snapshot.selectedProgram)
    )
    && Array.isArray(snapshot.properties)
    && snapshot.properties.every(validProperty)
    && Array.isArray(snapshot.textures)
    && snapshot.textures.every(validTexture)
    && Array.isArray(snapshot.materialKeywords)
    && snapshot.materialKeywords.every(validKeyword);
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function cloneIncludePointContext(context: IncludePointContext): IncludePointContext {
  return {
    ...context,
    includeLocation: {
      uri: context.includeLocation.uri,
      range: {
        start: { ...context.includeLocation.range.start },
        end: { ...context.includeLocation.range.end },
      },
    },
  };
}

function cloneCompilerEvidence(
  evidence: AdapterCompilerEvidence,
): AdapterCompilerEvidence {
  return {
    sources: evidence.sources.map((source) => ({
      identity: { ...source.identity },
      text: source.text,
      lineDirectiveNames: [...source.lineDirectiveNames],
    })),
    documents: evidence.documents.map((document) => ({ ...document })),
    provenance: {
      ...evidence.provenance,
      profile: { ...evidence.provenance.profile },
      sourceRevision: { ...evidence.provenance.sourceRevision },
    },
  };
}

const VALID_CALL_KINDS: readonly CSharpPropertyCallKind[] = [
  'property-to-id',
  'material-set',
  'material-get',
  'material-property-block-set',
  'material-property-block-get',
];

const VALID_ACCESSORS: readonly CSharpPropertyAccessor[] = [
  'property-to-id',
  'set-color',
  'get-color',
  'set-vector',
  'get-vector',
  'set-float',
  'get-float',
  'set-int',
  'get-int',
  'set-integer',
  'get-integer',
  'set-texture',
  'get-texture',
];

const VALID_NAME_ORIGINS: readonly CSharpPropertyNameOrigin[] = [
  'direct',
  'property-id',
  'dynamic',
];

const VALID_EXPRESSION_DETERMINISMS: readonly CSharpExpressionDeterminism[] = [
  'constant-string',
  'constant-concat',
  'dynamic',
];

const VALID_BINDING_DETERMINISMS: readonly CSharpBindingDeterminism[] = [
  'proven',
  'name-only',
  'unbound',
];

const VALID_PROPERTY_TYPES: readonly (ShaderLabPropertyType | null)[] = [
  null,
  '2D', '2DArray', '3D', 'Cube', 'CubeArray',
  'Color', 'Vector', 'Float', 'Range', 'Int', 'Integer',
];

function validRange(value: unknown): value is Range {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<Range>;
  const start = r.start;
  const end = r.end;
  if (!start || !end) return false;
  const { line: startLine, character: startChar } = start;
  const { line: endLine, character: endChar } = end;
  // All four coordinates must be safe nonnegative integers.
  if (!Number.isInteger(startLine) || startLine < 0) return false;
  if (!Number.isInteger(startChar) || startChar < 0) return false;
  if (!Number.isInteger(endLine) || endLine < 0) return false;
  if (!Number.isInteger(endChar) || endChar < 0) return false;
  // Lexicographic ordering: start must precede or equal end.
  if (startLine > endLine) return false;
  if (startLine === endLine && startChar > endChar) return false;
  return true;
}

function validShaderIdentity(
  value: unknown,
): value is CSharpShaderIdentity {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<CSharpShaderIdentity>;
  return nonEmptyString(s.name) && nonEmptyString(s.path);
}

/**
 * Structural validation for one raw C# property usage. Every field is checked
 * against its expected type; a usage whose propertyName or shader identity does
 * not exactly match the requested target is dropped as a foreign target. The
 * source revision (URI + content hash) must be well-formed and match the usage
 * URI so the document overlay can rule out stale positions.
 */
function validCSharpPropertyUsage(
  usage: unknown,
  target: CSharpPropertyTarget,
): usage is AdapterCSharpPropertyUsage {
  if (!usage || typeof usage !== 'object') return false;
  const u = usage as Partial<AdapterCSharpPropertyUsage>;

  if (!nonEmptyString(u.uri)) return false;
  if (!validRange(u.range)) return false;
  if (!nonEmptyString(u.propertyName)) return false;
  // Foreign property names must be rejected.
  if (u.propertyName !== target.propertyName) return false;
  // propertyType is required (ShaderLabPropertyType | null); undefined is invalid.
  if (u.propertyType === undefined) return false;
  if (!VALID_PROPERTY_TYPES.includes(u.propertyType)) return false;
  if (!VALID_CALL_KINDS.includes(u.callKind as CSharpPropertyCallKind)) return false;
  if (!VALID_ACCESSORS.includes(u.accessor as CSharpPropertyAccessor)) return false;
  if (!VALID_NAME_ORIGINS.includes(u.nameOrigin as CSharpPropertyNameOrigin)) return false;
  if (!accessorMatchesCallKind(
    u.callKind as CSharpPropertyCallKind,
    u.accessor as CSharpPropertyAccessor,
  )) return false;
  // receiverType is required (string | null); undefined is invalid.
  if (u.receiverType === undefined) return false;
  if (u.receiverType !== null && !nonEmptyString(u.receiverType)) return false;
  if (!VALID_EXPRESSION_DETERMINISMS.includes(
    u.expressionDeterminism as CSharpExpressionDeterminism,
  )) return false;
  if (!VALID_BINDING_DETERMINISMS.includes(
    u.bindingDeterminism as CSharpBindingDeterminism,
  )) return false;
  if (u.expressionDeterminism === 'dynamic') {
    if (u.nameOrigin !== 'dynamic') return false;
  } else if (u.nameOrigin === 'dynamic') {
    return false;
  }
  if (u.callKind === 'property-to-id' && u.nameOrigin !== 'direct') return false;

  // Shader identity: required for proven bindings, must be exactly null
  // (not undefined) otherwise.
  if (u.bindingDeterminism === 'proven') {
    if (!validShaderIdentity(u.shader)) return false;
    // Foreign shader targets must be rejected.
    if (u.shader.name !== target.shaderName) return false;
    if (u.shader.path !== target.shaderPath) return false;
  } else if (u.shader !== null) {
    return false;
  }

  // Source revision: URI must match the usage URI and content hash must be a
  // well-formed SHA-256 so the overlay can prove revision identity.
  if (!u.sourceRevision || typeof u.sourceRevision !== 'object') return false;
  if (u.sourceRevision.uri !== u.uri) return false;
  if (!isSha256(u.sourceRevision.contentHash)) return false;

  return true;
}

function accessorMatchesCallKind(
  callKind: CSharpPropertyCallKind,
  accessor: CSharpPropertyAccessor,
): boolean {
  switch (callKind) {
    case 'property-to-id':
      return accessor === 'property-to-id';
    case 'material-set':
    case 'material-property-block-set':
      return accessor.startsWith('set-');
    case 'material-get':
    case 'material-property-block-get':
      return accessor.startsWith('get-');
  }
}
