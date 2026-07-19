import type {
  AdapterSourceRevision,
  AdapterUnavailableReason,
  Position,
  Range,
  ShaderGraphCustomFunctionPort,
  ShaderGraphCustomFunctionUsage,
} from '@unity-shader-nav/shared';

export interface ShaderGraphSourceIdentity {
  readonly projectId: string;
  readonly instanceId: string;
}

/** Adapter payload before the registry validates and stamps provenance. */
export type AdapterShaderGraphCustomFunctionNode = Omit<
  ShaderGraphCustomFunctionUsage,
  'provenance'
>;

export interface AdapterShaderGraphAsset {
  readonly sourceRevision: AdapterSourceRevision;
  readonly nodes: readonly AdapterShaderGraphCustomFunctionNode[];
}

export type ShaderGraphSourceSnapshot =
  | {
      readonly status: 'available';
      readonly shaderGraphVersion: string;
      readonly revision: string;
      readonly collectedAt: number;
      readonly assets: readonly AdapterShaderGraphAsset[];
    }
  | {
      readonly status: 'unsupported-version';
      readonly shaderGraphVersion: string;
    };

/**
 * Versioned Adapter boundary. Implementations decode Unity-owned serialization;
 * the language server receives only logical node, port, and source-location facts.
 */
export interface ShaderGraphSource {
  readonly identity: ShaderGraphSourceIdentity;
  customFunctionNodes(): Promise<ShaderGraphSourceSnapshot>;
}

export type ShaderGraphUsageUnknownReason =
  | AdapterUnavailableReason
  | 'capability-unavailable'
  | 'source-unavailable'
  | 'source-identity-mismatch'
  | 'shader-graph-version-unsupported'
  | 'connection-changed'
  | 'invalid-evidence';

export type ShaderGraphUsageResult =
  | {
      readonly availability: 'available';
      readonly assetScope: 'complete';
      readonly shaderGraphVersion: string;
      readonly revision: string;
      readonly usages: readonly ShaderGraphCustomFunctionUsage[];
    }
  | {
      readonly availability: 'unknown';
      readonly assetScope: 'unknown';
      readonly reason: ShaderGraphUsageUnknownReason;
      readonly shaderGraphVersion?: string;
    };

export interface ShaderGraphUsageProvider {
  shaderGraphCustomFunctions(): Promise<ShaderGraphUsageResult>;
}

export function unknownShaderGraphUsage(
  reason: ShaderGraphUsageUnknownReason,
  shaderGraphVersion?: string,
): Extract<ShaderGraphUsageResult, { readonly availability: 'unknown' }> {
  return {
    availability: 'unknown',
    assetScope: 'unknown',
    reason,
    ...(shaderGraphVersion ? { shaderGraphVersion } : {}),
  };
}

export function validAdapterRange(value: unknown): value is Range {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Range>;
  if (!validPosition(candidate.start) || !validPosition(candidate.end)) return false;
  return candidate.start.line < candidate.end.line
    || (
      candidate.start.line === candidate.end.line
      && candidate.start.character <= candidate.end.character
    );
}

/** Deep-copy validated evidence before it crosses the mutable transport boundary. */
export function cloneShaderGraphNode(
  node: AdapterShaderGraphCustomFunctionNode,
): AdapterShaderGraphCustomFunctionNode {
  return {
    ...node,
    source: { ...node.source },
    ports: node.ports.map((port) => ({ ...port })),
    nodeRange: cloneRange(node.nodeRange),
    functionNameRange: cloneRange(node.functionNameRange),
    sourceRange: cloneRange(node.sourceRange),
  };
}

/** Validate the complete logical snapshot before the registry stamps provenance. */
export function validShaderGraphSnapshot(
  snapshot: Extract<ShaderGraphSourceSnapshot, { readonly status: 'available' }>,
  now: number,
): boolean {
  if (
    snapshot.status !== 'available'
    || !validNonEmptyString(snapshot.revision)
    || !Number.isFinite(snapshot.collectedAt)
    || snapshot.collectedAt < 0
    || snapshot.collectedAt > now
    || !Array.isArray(snapshot.assets)
  ) return false;

  const nodeIds = new Set<string>();
  for (const asset of snapshot.assets) {
    if (!validSourceRevision(asset?.sourceRevision) || !Array.isArray(asset.nodes)) {
      return false;
    }
    for (const node of asset.nodes) {
      const key = `${asset.sourceRevision.uri}\u0000${node?.nodeId}`;
      if (!validShaderGraphNode(node) || nodeIds.has(key)) return false;
      nodeIds.add(key);
    }
  }
  return true;
}

function cloneRange(range: Range): Range {
  return {
    start: { ...range.start },
    end: { ...range.end },
  };
}

function validSourceRevision(revision: unknown): revision is AdapterSourceRevision {
  if (!revision || typeof revision !== 'object') return false;
  const candidate = revision as Partial<AdapterSourceRevision>;
  return validFileUri(candidate.uri)
    && validNonEmptyString(candidate.assetGuid)
    && typeof candidate.contentHash === 'string'
    && /^[a-f\d]{64}$/i.test(candidate.contentHash);
}

function validShaderGraphNode(
  node: unknown,
): node is AdapterShaderGraphCustomFunctionNode {
  if (!node || typeof node !== 'object') return false;
  const candidate = node as Partial<AdapterShaderGraphCustomFunctionNode>;
  return validNonEmptyString(candidate.nodeId)
    && validNonEmptyString(candidate.displayName)
    && validNonEmptyString(candidate.functionName)
    && (candidate.precision === 'float' || candidate.precision === 'half')
    && validShaderGraphSource(candidate.source)
    && Array.isArray(candidate.ports)
    && candidate.ports.every(validShaderGraphPort)
    && validAdapterRange(candidate.nodeRange)
    && validAdapterRange(candidate.functionNameRange)
    && validAdapterRange(candidate.sourceRange)
    && rangeContains(candidate.nodeRange, candidate.functionNameRange)
    && rangeContains(candidate.nodeRange, candidate.sourceRange);
}

function rangeContains(outer: Range, inner: Range): boolean {
  return comparePosition(outer.start, inner.start) <= 0
    && comparePosition(inner.end, outer.end) <= 0;
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function validShaderGraphSource(
  source: unknown,
): source is AdapterShaderGraphCustomFunctionNode['source'] {
  if (!source || typeof source !== 'object') return false;
  const candidate = source as Partial<AdapterShaderGraphCustomFunctionNode['source']>;
  return validFileUri(candidate.uri)
    && validNonEmptyString(candidate.assetGuid)
    && typeof candidate.path === 'string'
    && /^(?:Assets|Packages)\//.test(candidate.path)
    && !candidate.path.split('/').includes('..');
}

function validShaderGraphPort(port: unknown): port is ShaderGraphCustomFunctionPort {
  if (!port || typeof port !== 'object') return false;
  const candidate = port as Partial<ShaderGraphCustomFunctionPort>;
  return validNonEmptyString(candidate.name)
    && (candidate.direction === 'input' || candidate.direction === 'output')
    && validNonEmptyString(candidate.type);
}

function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validFileUri(value: unknown): value is string {
  if (!validNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}

function validPosition(value: unknown): value is Range['start'] {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Range['start']>;
  return Number.isInteger(candidate.line)
    && Number.isInteger(candidate.character)
    && candidate.line! >= 0
    && candidate.character! >= 0;
}
