import type { AdapterSourceRevision } from './adapter';
import type { Range } from './symbols';
import type { ShaderStage } from './structure';

/** Versioned capability for the first bounded GPU capture correlation seam. */
export const GPU_CAPTURE_CORRELATION_CAPABILITY =
  'gpu-capture-correlation/v1';

export interface GpuCapturePlatform {
  readonly operatingSystem: 'macOS';
  readonly operatingSystemVersion: string;
  readonly architecture: 'arm64';
}

export interface GpuCaptureDevice {
  readonly name: string;
  /** Unity/SystemInfo or Metal-reported driver/device version string. */
  readonly driverVersion: string;
  readonly registryId?: string;
}

export interface GpuCaptureTool {
  readonly name: 'Xcode Metal Frame Debugger';
  readonly version: string;
  readonly buildVersion: string;
  readonly metalCompilerVersion: string;
  readonly traceFormat: 'gputrace';
}

export interface GpuCaptureProvenance {
  readonly capability: typeof GPU_CAPTURE_CORRELATION_CAPABILITY;
  readonly adapterVersion: string;
  /** Unity's public Editor version (for example 2022.3.62f1). */
  readonly unityVersion: string;
  /** Exact selected Editor binary identity reported by `Unity -version`. */
  readonly unityBinaryVersion: string;
  readonly projectId: string;
  readonly instanceId: string;
  /** Unix epoch milliseconds. */
  readonly collectedAt: number;
  readonly platform: GpuCapturePlatform;
  readonly gpu: GpuCaptureDevice;
  readonly graphicsApi: 'Metal';
  readonly tool: GpuCaptureTool;
  readonly sourceRevision: AdapterSourceRevision;
}

export interface CapturedShaderContext {
  readonly id: string;
  readonly shaderName: string;
  readonly subShaderIndex: number;
  readonly passIndex: number;
  readonly passName?: string;
  readonly stage: ShaderStage;
  readonly entryPoint: string;
  readonly keywords: {
    readonly enabled: readonly string[];
    /** True when captured facts do not prove the complete runtime keyword set. */
    readonly incomplete: boolean;
  };
}

export interface CapturedDrawIdentity {
  readonly captureId: string;
  readonly frameIndex: number;
  readonly drawIndex: number;
  readonly label: string;
  readonly trace: {
    /** Raw traces are local derived data and are never repository artifacts. */
    readonly storage: 'local-ephemeral';
    readonly fileName: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
}

export type GpuCaptureMappingFailure =
  | 'generated-source-has-no-line-map'
  | 'entry-point-not-found'
  | 'ambiguous-source-range'
  | 'capture-tool-omitted-shader-text'
  | 'unsupported-trace-version';

export type GpuCaptureSourceMapping =
  | {
      readonly status: 'mapped';
      readonly method: 'adapter-exact-source-range';
      readonly uri: string;
      readonly range: Range;
      /** Exact text expected at range; prevents range-only accidental matches. */
      readonly expectedText: string;
      /** Adapter-owned source entry point bound before capture. */
      readonly sourceEntryPoint: string;
    }
  | {
      readonly status: 'unmapped';
      readonly reason: GpuCaptureMappingFailure;
      readonly detail: string;
    };

export interface GpuCaptureEvidence {
  readonly schemaVersion: 1;
  readonly provenance: GpuCaptureProvenance;
  readonly draw: CapturedDrawIdentity;
  readonly context: CapturedShaderContext;
  readonly mapping: GpuCaptureSourceMapping;
}

export interface GpuCaptureReplayEnvironment {
  readonly operatingSystem: 'macOS';
  readonly operatingSystemVersion: string;
  readonly architecture: 'arm64';
  readonly graphicsApi: 'Metal';
  readonly gpuName: string;
  readonly gpuDriverVersion: string;
  readonly toolName: 'Xcode Metal Frame Debugger';
  readonly toolVersion: string;
  readonly toolBuildVersion: string;
  readonly metalCompilerVersion: string;
  readonly unityVersion: string;
  readonly unityBinaryVersion: string;
  readonly adapterVersion: string;
}

export type GpuCaptureTraceVerification =
  | {
      readonly status: 'verified-local-trace';
      readonly fileName: string;
      readonly sha256: string;
      readonly byteLength: number;
      /** Bounded labels independently observed in the raw trace bytes. */
      readonly labels: readonly string[];
    }
  | {
      /** Test-only trust level for a checked-in bounded fixture with no trace. */
      readonly status: 'sanitized-fixture';
    };

export type GpuCaptureCorrelationResult =
  | {
      readonly status: 'current';
      readonly traceStatus: GpuCaptureTraceVerification['status'];
      readonly evidence: GpuCaptureEvidence;
      readonly uri: string;
      readonly range: Range;
      readonly context: CapturedShaderContext;
    }
  | {
      readonly status: 'stale';
      readonly reason:
        | 'source-hash-mismatch'
        | 'source-uri-mismatch'
        | 'asset-guid-mismatch';
      readonly evidence: GpuCaptureEvidence;
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'invalid-evidence'
        | 'project-mismatch'
        | 'replay-environment-mismatch'
        | 'trace-identity-mismatch'
        | 'trace-label-missing';
      readonly detail: string;
    }
  | {
      readonly status: 'unmapped';
      readonly reason:
        | GpuCaptureMappingFailure
        | 'mapped-range-invalid'
        | 'mapped-text-mismatch';
      readonly detail: string;
      readonly evidence: GpuCaptureEvidence;
    };
