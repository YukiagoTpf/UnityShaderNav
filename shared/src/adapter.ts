/** Custom pull request: client asks for the current Unity Editor Adapter status. */
export const ADAPTER_STATUS_REQUEST = 'unityShaderNav/adapterStatus';

/** Version of the handshake contract, independent from the Adapter release version. */
export const ADAPTER_INTERFACE_VERSION = 1;

/** Capability that refreshes compiler messages for one saved Shader asset. */
export const SHADER_MESSAGES_CAPABILITY = 'shader-messages';

/** One compiler target explicitly advertised by the connected Adapter. */
export interface CompileProfile {
  /** Stable Adapter-owned identity presented to users. */
  readonly name: string;
  readonly platform: string;
  readonly graphicsApi: string;
  /** Capability that must be present in the current Adapter handshake. */
  readonly capability: string;
}

export interface AdapterCapabilities {
  readonly unityVersion: string;
  readonly projectId: string;
  readonly adapterVersion: string;
  readonly supportedFeatures: readonly string[];
}

/** Evidence supplied by one local Adapter connection. */
export interface AdapterHandshake {
  readonly interfaceVersion: number;
  readonly issuedAt: number;
  /** Identity of the currently connected Editor endpoint. */
  readonly instanceId: string;
  readonly capabilities: AdapterCapabilities;
}

/** UnityEditor.ShaderMessage serialized without Unity runtime dependencies. */
export interface ShaderMessage {
  readonly message: string;
  readonly messageDetails?: string;
  readonly file?: string;
  /** One-based source line reported by Unity, when supplied. */
  readonly line?: number;
  readonly severity: 'error' | 'warning';
  readonly platform?: string;
}

export interface AdapterSourceRevision {
  readonly uri: string;
  readonly assetGuid: string;
  /** SHA-256 of the saved asset contents observed by the Adapter. */
  readonly contentHash: string;
}

export interface AdapterDiagnosticProvenance {
  readonly capability: typeof SHADER_MESSAGES_CAPABILITY;
  readonly adapterVersion: string;
  readonly unityVersion: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly collectedAt: number;
  readonly sourceRevision: AdapterSourceRevision;
}

/** One compiler message together with the evidence needed to trust it. */
export interface AdapterDiagnostic {
  readonly shaderMessage: ShaderMessage;
  readonly provenance: AdapterDiagnosticProvenance;
}

/** A validated compiler diagnostic stamped with the profile that produced it. */
export interface ProfiledAdapterDiagnostic extends AdapterDiagnostic {
  readonly profile: CompileProfile;
}

export type AdapterUnavailableReason =
  | 'no-adapter'
  | 'stale'
  | 'foreign-project'
  | 'disconnected'
  | 'version-incompatible';

export type CompileProfileUnavailableReason =
  | AdapterUnavailableReason
  | 'profile-source-unavailable'
  | 'shader-message-source-unavailable'
  | 'connection-changed'
  | 'analysis-cancelled'
  | 'invalid-evidence';

export type CompileProfileDiscovery =
  | {
      readonly status: 'available';
      readonly profiles: readonly CompileProfile[];
    }
  | {
      readonly status: 'adapter-unavailable';
      readonly reason: CompileProfileUnavailableReason;
    };

export type CompileProfileRunResult =
  | {
      readonly status: 'completed';
      readonly profile: CompileProfile;
      readonly durationMs: number;
      readonly success: boolean;
      readonly warningCount: number;
      readonly errorCount: number;
      readonly diagnostics: readonly ProfiledAdapterDiagnostic[];
    }
  | {
      readonly status: 'profile-not-supported';
      readonly requestedProfile: CompileProfile;
      readonly availableProfiles: readonly CompileProfile[];
    }
  | {
      readonly status: 'adapter-unavailable';
      readonly requestedProfile: CompileProfile;
      readonly reason: CompileProfileUnavailableReason;
    };

export type CompileProfileRunStatus =
  | CompileProfileRunResult
  | {
      readonly status: 'running';
      readonly profile: CompileProfile;
    };

export type AdapterStatus =
  | {
      readonly mode: 'adapter';
      readonly capabilities: AdapterCapabilities;
    }
  | {
      readonly mode: 'standalone';
      readonly reason: AdapterUnavailableReason;
    };
