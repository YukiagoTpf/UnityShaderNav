import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  FunctionSymbolEntry,
  ShaderGraphCustomFunctionUsage,
  ShaderGraphReferenceLocation,
  ShaderGraphReferenceData,
  SymbolEntry,
} from '@unity-shader-nav/shared';
import {
  DiagnosticSeverity,
  type Diagnostic,
  type Location,
  type LocationLink,
} from 'vscode-languageserver/node';
import {
  awaitWithRequestCancellation,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import {
  cursorTargetAt,
  resolveDefinition,
  type ResolverContext,
} from '../index';
import { uriKey } from '../uriKey';
import {
  containsPosition,
  symbolToLocationLink,
} from '../sourceLocation';
import type { ShaderGraphUsageResult } from '../adapter/shaderGraphSource';
import type { DefinitionAtInput } from './indexedWorkspace';
import type {
  OpenDocumentsProvider,
  ReferencesAtInput,
} from './indexedWorkspace';
import type { WorkspaceNavigationState } from './navigation';
import type { CursorRequestFacts } from './requestFacts';
import type { PreprocessorContext } from '../parser/preproc/context';
import { isShaderLabUri } from '../sourceLocation';
import {
  SHADER_GRAPH_INVALID_SUFFIX_CODE,
  SHADER_GRAPH_SIGNATURE_MISMATCH_CODE,
  SHADER_GRAPH_SOURCE_MISSING_CODE,
} from './diagnosticCodes';

const SHADER_GRAPH_URI = /\.shadergraph(?:$|[?#])/i;
const PRECISION_SUFFIX = /_(?:float|half)$/;

export function isShaderGraphUri(uri: string): boolean {
  return SHADER_GRAPH_URI.test(uri);
}

/**
 * Accept Adapter facts only for the exact graph text currently visible to the
 * language server. Hashing proves revision identity without decoding the asset.
 */
export function shaderGraphUsagesForDocument(
  result: ShaderGraphUsageResult,
  document: DefinitionAtInput['document'],
): readonly ShaderGraphCustomFunctionUsage[] {
  if (result.availability !== 'available') return [];
  const contentHash = createHash('sha256')
    .update(document.text, 'utf8')
    .digest('hex');
  const key = uriKey(document.uri);
  return result.usages.filter((usage) => (
    uriKey(usage.provenance.sourceRevision.uri) === key
    && usage.provenance.sourceRevision.contentHash === contentHash
    && graphRangesWithinText(usage, document.text)
  ));
}

/** Validate saved graph revisions without interpreting Shader Graph serialization. */
export async function currentShaderGraphUsages(
  result: ShaderGraphUsageResult,
  openDocuments: OpenDocumentsProvider | undefined,
  cancellation?: ReferencesAtInput['cancellation'],
): Promise<readonly ShaderGraphCustomFunctionUsage[]> {
  if (result.availability !== 'available') return [];
  throwIfRequestCancelled(cancellation);
  const openByUri = new Map(
    [...(openDocuments?.() ?? [])].map((document) => [uriKey(document.uri), document.text]),
  );
  interface CurrentGraphSource {
    readonly text: string;
    readonly contentHash: string;
  }
  const sources = new Map<string, Promise<CurrentGraphSource | undefined>>();
  const currentSource = (uri: string): Promise<CurrentGraphSource | undefined> => {
    const key = uriKey(uri);
    let pending = sources.get(key);
    if (pending) return pending;
    pending = (async () => {
      const open = openByUri.get(key);
      try {
        const text = open ?? await readFile(fileURLToPath(uri), 'utf8');
        return {
          text,
          contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        };
      } catch {
        return undefined;
      }
    })();
    sources.set(key, pending);
    return pending;
  };

  const freshness = await awaitWithRequestCancellation(
    Promise.all(result.usages.map(async (usage) => ({
      usage,
      current: await currentSource(usage.provenance.sourceRevision.uri),
    }))),
    cancellation,
  );
  throwIfRequestCancelled(cancellation);
  return freshness
    .filter(({ usage, current }) => (
      current !== undefined
      && current.contentHash === usage.provenance.sourceRevision.contentHash
      && graphRangesWithinText(usage, current.text)
    ))
    .map(({ usage }) => usage);
}

/** Definition from one Adapter-owned graph node to an exact indexed function. */
export function shaderGraphDefinition(
  state: WorkspaceNavigationState,
  input: DefinitionAtInput,
  usages: readonly ShaderGraphCustomFunctionUsage[],
): LocationLink[] | null {
  const links: LocationLink[] = [];
  const seen = new Set<string>();
  for (const usage of usages) {
    if (!containsPosition(usage.nodeRange, input.position)) continue;
    const targetName = precisionSuffixedName(usage);
    if (!targetName) continue;
    const index = state.index.store.get(usage.source.uri);
    if (!index) continue;
    for (const symbol of index.symbols) {
      if (!isFunctionSymbol(symbol) || symbol.name !== targetName) continue;
      if (!functionMatchesPorts(symbol, usage)) continue;
      const key = `${uriKey(symbol.location.uri)}:${symbol.location.range.start.line}:${symbol.location.range.start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        ...symbolToLocationLink(symbol, usage.functionNameRange),
        data: shaderGraphReferenceData(usage),
      } as LocationLink);
    }
  }
  return links.length > 0 ? links : null;
}

/** Add graph node usages to Find References for the resolved HLSL function. */
export async function shaderGraphReferences(
  state: WorkspaceNavigationState,
  input: ReferencesAtInput,
  usages: readonly ShaderGraphCustomFunctionUsage[],
  facts?: CursorRequestFacts,
  context?: PreprocessorContext,
): Promise<Location[]> {
  if (usages.length === 0) return [];
  throwIfRequestCancelled(input.cancellation);
  const index = state.index.store.get(input.document.uri);
  if (!index) return [];
  const target = facts?.target() ?? cursorTargetAt(input.document.text, input.position);
  if (target.kind !== 'symbol' && target.kind !== 'member') return [];
  const direct = index.symbols.filter((symbol): symbol is FunctionSymbolEntry => (
    isFunctionSymbol(symbol)
    && containsPosition(symbol.location.range, input.position)
  ));
  const visibleUriKeys = await awaitWithRequestCancellation(
    state.includeChain.visibleUriKeys(input.document.uri),
    input.cancellation,
  );
  const resolverContext: ResolverContext = {
    index,
    global: state.index.global,
    position: input.position,
    options: { visibleUriKeys },
    variantContext: context,
    getText: (uri: string) => (
      uriKey(uri) === uriKey(input.document.uri) ? input.document.text : undefined
    ),
    isShaderLab: isShaderLabUri(input.document.uri),
  };
  const resolved = direct.length > 0
    ? direct
    : resolveDefinition(target, resolverContext).filter(isFunctionSymbol);
  if (resolved.length === 0) return [];

  const locations: ShaderGraphReferenceLocation[] = [];
  const seen = new Set<string>();
  for (const usage of usages) {
    const targetName = precisionSuffixedName(usage);
    if (!targetName) continue;
    const matches = resolved.some((symbol) => (
      symbol.name === targetName
      && uriKey(symbol.location.uri) === uriKey(usage.source.uri)
      && functionMatchesPorts(symbol, usage)
    ));
    if (!matches) continue;
    const key = `${uriKey(usage.provenance.sourceRevision.uri)}:${usage.nodeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({
      uri: usage.provenance.sourceRevision.uri,
      range: usage.functionNameRange,
      data: shaderGraphReferenceData(usage),
    });
  }
  throwIfRequestCancelled(input.cancellation);
  return locations;
}

export function shaderGraphDiagnostics(
  state: WorkspaceNavigationState,
  usages: readonly ShaderGraphCustomFunctionUsage[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const usage of usages) {
    const source = shaderGraphDiagnosticSource(usage);
    const data = shaderGraphReferenceData(usage);
    const suffix = /_(float|half)$/.exec(usage.functionName)?.[0];
    const targetName = precisionSuffixedName(usage);
    if (!targetName) {
      diagnostics.push({
        range: usage.functionNameRange,
        severity: DiagnosticSeverity.Error,
        code: SHADER_GRAPH_INVALID_SUFFIX_CODE,
        source,
        message: suffix
          ? `Custom Function name '${usage.functionName}' must omit the precision suffix '${suffix}'; Shader Graph appends it from node precision.`
          : `Custom Function name '${usage.functionName}' is not a valid unsuffixed HLSL identifier.`,
        data,
      });
      continue;
    }

    const index = state.index.store.get(usage.source.uri);
    if (!index) {
      diagnostics.push({
        range: usage.sourceRange,
        severity: DiagnosticSeverity.Error,
        code: SHADER_GRAPH_SOURCE_MISSING_CODE,
        source,
        message: `Custom Function node '${usage.displayName}' references missing include '${usage.source.path}'.`,
        data,
      });
      continue;
    }
    const candidates = index.symbols.filter((symbol): symbol is FunctionSymbolEntry => (
      isFunctionSymbol(symbol) && symbol.name === targetName
    ));
    if (candidates.length === 0) {
      diagnostics.push({
        range: usage.functionNameRange,
        severity: DiagnosticSeverity.Error,
        code: SHADER_GRAPH_INVALID_SUFFIX_CODE,
        source,
        message: `Include '${usage.source.path}' has no precision-suffixed function '${targetName}'.`,
        data,
      });
      continue;
    }
    if (!candidates.some((candidate) => functionMatchesPorts(candidate, usage))) {
      diagnostics.push({
        range: usage.functionNameRange,
        severity: DiagnosticSeverity.Error,
        code: SHADER_GRAPH_SIGNATURE_MISMATCH_CODE,
        source,
        message: `Function '${targetName}' does not match node ports; expected ${expectedSignature(targetName, usage)}.`,
        data,
      });
    }
  }
  return diagnostics;
}

export function precisionSuffixedName(
  usage: Pick<ShaderGraphCustomFunctionUsage, 'functionName' | 'precision'>,
): string | undefined {
  if (!/^[A-Za-z_]\w*$/.test(usage.functionName)) return undefined;
  if (PRECISION_SUFFIX.test(usage.functionName)) return undefined;
  return `${usage.functionName}_${usage.precision}`;
}

export function functionMatchesPorts(
  symbol: FunctionSymbolEntry,
  usage: Pick<ShaderGraphCustomFunctionUsage, 'ports'>,
): boolean {
  return symbol.returnType === 'void'
    && symbol.parameters.length === usage.ports.length
    && symbol.parameters.every((parameter, index) => {
      const port = usage.ports[index];
      return !!port
        && parameter.name === port.name
        && normalizeHlslType(parameter.type) === normalizeHlslType(port.type)
        && (port.direction === 'output'
          ? parameter.direction === 'out'
          : parameter.direction === undefined);
    });
}

function expectedSignature(
  targetName: string,
  usage: Pick<ShaderGraphCustomFunctionUsage, 'ports'>,
): string {
  const parameters = usage.ports.map((port) => (
    `${port.direction === 'output' ? 'out ' : ''}${port.type} ${port.name}`
  )).join(', ');
  return `void ${targetName}(${parameters})`;
}

function shaderGraphDiagnosticSource(usage: ShaderGraphCustomFunctionUsage): string {
  const { provenance } = usage;
  return `Unity Shader Graph [Adapter] (Unity ${provenance.unityVersion}, Shader Graph ${provenance.shaderGraphVersion})`;
}

function isFunctionSymbol(symbol: SymbolEntry): symbol is FunctionSymbolEntry {
  return symbol.kind === 'function'
    && typeof (symbol as Partial<FunctionSymbolEntry>).returnType === 'string'
    && Array.isArray((symbol as Partial<FunctionSymbolEntry>).parameters);
}

function normalizeHlslType(type: string): string {
  return type.trim().replace(/\s+/g, ' ');
}

function graphRangesWithinText(
  usage: Pick<
    ShaderGraphCustomFunctionUsage,
    'nodeRange' | 'functionNameRange' | 'sourceRange'
  >,
  text: string,
): boolean {
  const lines = text.split(/\r\n|\r|\n/);
  return [usage.nodeRange, usage.functionNameRange, usage.sourceRange]
    .every((range) => (
      range.start.line < lines.length
      && range.end.line < lines.length
      && range.start.character <= (lines[range.start.line]?.length ?? -1)
      && range.end.character <= (lines[range.end.line]?.length ?? -1)
    ));
}

export function shaderGraphReferenceData(
  usage: ShaderGraphCustomFunctionUsage,
): ShaderGraphReferenceData {
  return {
    kind: 'shader-graph-custom-function',
    node: { id: usage.nodeId, displayName: usage.displayName },
    functionName: usage.functionName,
    precision: usage.precision,
    source: { ...usage.source },
    provenance: {
      ...usage.provenance,
      sourceRevision: { ...usage.provenance.sourceRevision },
    },
  };
}
