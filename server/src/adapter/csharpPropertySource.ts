import type {
  AdapterUnavailableReason,
  CSharpPropertyUsage,
} from '@unity-shader-nav/shared';

export interface CSharpPropertySourceIdentity {
  readonly projectId: string;
  readonly instanceId: string;
}

/** Shader + Property target the Adapter resolves call sites against. */
export interface CSharpPropertyTarget {
  /** Shader name as declared in ShaderLab, e.g. "Tests/Lit". */
  readonly shaderName: string;
  /** Project-relative shader asset path, e.g. "Assets/Shaders/Lit.shader". */
  readonly shaderPath: string;
  /** Property name as written, e.g. "_MainTex". */
  readonly propertyName: string;
}

/** Adapter payload before the registry stamps trusted provenance. */
export type AdapterCSharpPropertyUsage = Omit<CSharpPropertyUsage, 'provenance'>;

export type CSharpPropertySourceSnapshot =
  | {
      readonly assetScope: 'complete';
      readonly revision: string;
      readonly collectedAt: number;
      readonly usages: readonly AdapterCSharpPropertyUsage[];
    }
  | {
      readonly assetScope: 'unknown';
      readonly reason: 'asset-scope-unavailable';
    };

/**
 * Pluggable Adapter boundary. A transport can implement it later; tests use a
 * mutable in-memory source so C# call-site revisions never enter the source
 * index.
 */
export interface CSharpPropertySource {
  readonly identity: CSharpPropertySourceIdentity;
  csharpPropertyUsagesFor(
    target: CSharpPropertyTarget,
  ): Promise<CSharpPropertySourceSnapshot>;
}

export type CSharpPropertyUsageUnknownReason =
  | AdapterUnavailableReason
  | 'capability-unavailable'
  | 'source-unavailable'
  | 'source-identity-mismatch'
  | 'asset-scope-unavailable'
  | 'invalid-evidence';

export type CSharpPropertyUsageResult =
  | {
      readonly availability: 'available';
      readonly assetScope: 'complete';
      readonly revision: string;
      readonly usages: readonly CSharpPropertyUsage[];
    }
  | {
      readonly availability: 'unknown';
      readonly assetScope: 'unknown';
      readonly reason: CSharpPropertyUsageUnknownReason;
    };

/** Read-only query surface consumed by Workspace overlays. */
export interface CSharpPropertyUsageProvider {
  csharpPropertyUsagesFor(
    target: CSharpPropertyTarget,
  ): Promise<CSharpPropertyUsageResult>;
}

/**
 * The current C# source text for one URI, as observable to the language server
 * without registering a C# language provider. The production client does not
 * include `csharp` in its documentSelector, so the server cannot observe open
 * C# buffers through the normal document registry. This provider is an explicit,
 * optional dependency: when absent or returning `null`, no authoritative C#
 * reference can be produced.
 *
 * - `open-buffer`: an editor buffer (dirty or clean) the provider can observe.
 * - `closed-saved`: read from the saved file on disk.
 *
 * The content hash is computed by the resolver from `text`, not carried by the
 * snapshot, so a provider cannot bypass freshness by reporting a stale hash
 * alongside mismatched text.
 *
 * The client-side bridge distinguishes open-buffer, closed-saved, and unknown
 * without registering a C# language provider. The server computes the hash
 * from returned text before enabling authoritative evidence.
 */
export interface CSharpCurrentSourceSnapshot {
  readonly text: string;
  readonly availability: 'open-buffer' | 'closed-saved';
}

export interface CSharpCurrentSourceProvider {
  /** `null` means the current source is unknown (not observable). */
  currentSourceFor(uri: string): Promise<CSharpCurrentSourceSnapshot | null>;
}

export function unknownCSharpPropertyUsage(
  reason: CSharpPropertyUsageUnknownReason,
): Extract<CSharpPropertyUsageResult, { readonly availability: 'unknown' }> {
  return {
    availability: 'unknown',
    assetScope: 'unknown',
    reason,
  };
}
