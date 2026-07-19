import { createHash } from 'node:crypto';
import type {
  AdapterCompilerEvidence,
  AdapterStatus,
  CompileProfile,
  CompilerDocumentKind,
  CompilerEvidenceStaleReason,
  CompilerMappedLocation,
  CompilerMappingParams,
  CompilerMappingProvenance,
  CompilerMappingResult,
  CompilerSourceIdentity,
  CompilerViewsResult,
  CompilerVirtualDocumentResult,
  IncludePointContext,
  ProfiledAdapterDiagnostic,
  Range,
} from '@unity-shader-nav/shared';
import type { AdapterRegistry } from './adapterRegistry';
import {
  buildCompilerDocumentMap,
  COMPILER_DOCUMENT_HEADER_LINES,
  mapFromCompilerDocument,
  mappedLinesForSource,
  mapToCompilerDocument,
  rawDocumentPosition,
  type CompilerDocumentMap,
} from './compilerSourceMap';
import { uriKey } from '../uriKey';

export interface CompilerDiagnosticResolution {
  readonly evidenceId: string;
  readonly uri: string;
  readonly range: Range;
  readonly sourceIdentity: CompilerSourceIdentity;
  readonly provenance: CompilerMappingProvenance;
  readonly generatedEvidence: readonly CompilerMappedLocation[];
}

export interface CompilerEvidenceServiceOptions {
  readonly registry: AdapterRegistry;
  selectedContextFor(
    uri: string,
  ): Promise<{
    readonly folderUri: string;
    readonly context: IncludePointContext;
  } | undefined>;
  sourceText(uri: string): Promise<string | undefined>;
}

interface EvidenceRecord {
  readonly id: string;
  readonly evidence: AdapterCompilerEvidence;
  readonly folderUri: string;
  readonly context: IncludePointContext;
  readonly maps: ReadonlyMap<CompilerDocumentKind, CompilerDocumentMap>;
  readonly virtualUris: readonly string[];
  staleReason?: CompilerEvidenceStaleReason;
}

/**
 * Owns ephemeral compiler documents and mappings. Evidence is never indexed or
 * persisted; old records remain readable but become non-navigable when stale.
 */
export class CompilerEvidenceService {
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly recordByVirtualUri = new Map<string, EvidenceRecord>();
  private readonly listeners = new Set<(uris: readonly string[]) => void>();

  constructor(private readonly options: CompilerEvidenceServiceOptions) {
    options.registry.onDidChangeStatus((status) => this.handleAdapterStatus(status));
  }

  onDidChange(listener: (uris: readonly string[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  async viewsFor(uri: string, profile: CompileProfile): Promise<CompilerViewsResult> {
    const selected = await this.options.selectedContextFor(uri);
    if (!selected) return { status: 'unavailable', reason: 'context-unavailable' };
    const { context, folderUri } = selected;
    const source = await this.options.sourceText(context.shaderUri);
    if (source === undefined) return { status: 'unavailable', reason: 'source-unavailable' };

    const contentHash = sha256(source);
    const result = await this.options.registry.compilerEvidenceFor(
      context,
      contentHash,
      profile,
    );
    if (result.status === 'unavailable') return result;

    const evidence = result.evidence;
    const id = evidenceIdentity(evidence);
    let record = this.records.get(id);
    if (!record) {
      record = this.createRecord(id, folderUri, context, evidence);
      this.records.set(id, record);
      for (const virtualUri of record.virtualUris) {
        this.recordByVirtualUri.set(virtualUri, record);
      }
      if (!await this.currentSourcesMatch(record)) {
        this.markStale(record, 'source-hash-mismatch');
      } else {
        this.publish(record.virtualUris);
      }
    } else if (record.staleReason && await this.currentSourcesMatch(record)) {
      record.staleReason = undefined;
      this.publish(record.virtualUris);
    }
    if (!record.staleReason) this.supersedeOlderRecords(record);
    this.pruneRecords(record);
    return viewsResult(record);
  }

  virtualDocument(uri: string): CompilerVirtualDocumentResult {
    const record = this.recordByVirtualUri.get(uri);
    const map = record?.maps.get(kindForVirtualUri(uri));
    if (!record || !map) {
      return { status: 'unavailable', reason: 'evidence-unavailable' };
    }
    return {
      status: 'available',
      content: renderVirtualDocument(record, map),
      stale: record.staleReason !== undefined,
      ...(record.staleReason ? { staleReason: record.staleReason } : {}),
    };
  }

  map(params: CompilerMappingParams): CompilerMappingResult {
    const record = params.evidenceId
      ? this.records.get(params.evidenceId)
      : this.recordByVirtualUri.get(params.uri);
    if (!record) return { status: 'unavailable', reason: 'evidence-unavailable' };
    if (record.staleReason) {
      return {
        status: 'stale',
        reason: record.staleReason,
        provenance: record.evidence.provenance,
      };
    }

    const sourceMap = this.recordByVirtualUri.get(params.uri) === record
      ? record.maps.get(kindForVirtualUri(params.uri))
      : undefined;
    if (sourceMap) {
      const source = mapFromCompilerDocument(sourceMap, params.position);
      if (source.locations.length === 0) {
        return {
          status: 'unmapped',
          reason: source.unmappedReason ?? 'no-reliable-mapping',
          provenance: record.evidence.provenance,
        };
      }
      if (params.target === 'source') {
        return {
          status: 'mapped',
          evidenceId: record.id,
          locations: dedupeLocations(source.locations),
        };
      }
      const target = record.maps.get(params.target);
      if (!target) return { status: 'unavailable', reason: 'target-unavailable' };
      const locations = source.locations.flatMap((location) => (
        mapToCompilerDocument(
          target,
          location.sourceIdentity.uri,
          location.range.start,
        )
      ));
      return locations.length > 0
        ? { status: 'mapped', evidenceId: record.id, locations: dedupeLocations(locations) }
        : {
            status: 'unmapped',
            reason: 'no-reliable-mapping',
            provenance: record.evidence.provenance,
          };
    }

    if (params.target === 'source') {
      return { status: 'unavailable', reason: 'target-unavailable' };
    }
    const target = record.maps.get(params.target);
    if (!target) return { status: 'unavailable', reason: 'target-unavailable' };
    const locations = mapToCompilerDocument(target, params.uri, params.position);
    return locations.length > 0
      ? { status: 'mapped', evidenceId: record.id, locations: dedupeLocations(locations) }
      : {
          status: 'unmapped',
          reason: 'no-reliable-mapping',
          provenance: record.evidence.provenance,
        };
  }

  markSourceChanged(
    uri: string,
    text?: string,
    deleted = false,
  ): void {
    const key = uriKey(uri);
    const currentHash = text === undefined ? undefined : sha256(text);
    for (const record of this.records.values()) {
      const source = record.evidence.sources.find(({ identity }) => (
        uriKey(identity.uri) === key
      ));
      if (!source || record.staleReason) continue;
      if (!deleted && currentHash === source.identity.contentHash) continue;
      this.markStale(record, deleted ? 'source-deleted' : 'source-changed');
    }
  }

  markContextChanged(folderUri: string, contextId?: string): void {
    const folderKey = uriKey(folderUri);
    for (const record of this.records.values()) {
      if (
        uriKey(record.folderUri) !== folderKey
        || record.staleReason
        || record.context.id === contextId
      ) continue;
      this.markStale(record, 'superseded');
    }
  }

  isCurrent(evidenceId: string): boolean {
    const record = this.records.get(evidenceId);
    return !!record && record.staleReason === undefined;
  }

  resolveDiagnostic(
    diagnostic: ProfiledAdapterDiagnostic,
  ): CompilerDiagnosticResolution | undefined {
    const record = this.currentRecordForDiagnostic(diagnostic);
    if (!record) return undefined;
    const reportedLine = diagnostic.shaderMessage.line;
    if (!Number.isFinite(reportedLine) || reportedLine === undefined) return undefined;
    const sourceLine = Math.trunc(reportedLine) - 1;
    if (sourceLine < 0) return undefined;
    const file = diagnostic.shaderMessage.file;
    if (!file) return undefined;

    const sourceMatches = record.evidence.sources.filter((source) => (
      source.identity.uri === file || source.lineDirectiveNames.includes(file)
    ));
    if (sourceMatches.length === 1) {
      const source = sourceMatches[0]!;
      const sourceText = source.text.split(/\r\n|\r|\n/)[sourceLine];
      if (sourceText === undefined) return undefined;
      const range = lineRange(sourceLine, sourceText.length);
      const provenance: CompilerMappingProvenance = {
        method: 'compiler-reported-source',
        granularity: 'line',
        evidence: record.evidence.provenance,
      };
      return {
        evidenceId: record.id,
        uri: source.identity.uri,
        range,
        sourceIdentity: { ...source.identity },
        provenance,
        generatedEvidence: record.maps.get('generated')
          ? mappedLinesForSource(
              record.maps.get('generated')!,
              source.identity.uri,
              sourceLine,
            )
          : [],
      };
    }

    const documentMatches = [...record.maps.values()].filter((map) => (
      map.compilerPath === file
    ));
    if (documentMatches.length !== 1) return undefined;
    const mapped = mapFromCompilerDocument(
      documentMatches[0]!,
      rawDocumentPosition(sourceLine),
    ).locations;
    if (mapped.length !== 1) return undefined;
    const location = mapped[0]!;
    return {
      evidenceId: record.id,
      uri: location.uri,
      range: location.range,
      sourceIdentity: location.sourceIdentity,
      provenance: location.provenance,
      generatedEvidence: documentMatches[0]!.kind === 'generated'
        ? [{
            ...location,
            uri: documentMatches[0]!.virtualUri,
            range: lineRange(
              sourceLine + COMPILER_DOCUMENT_HEADER_LINES,
              documentMatches[0]!.rawText.split(/\r\n|\r|\n/)[sourceLine]?.length ?? 0,
            ),
          }]
        : record.maps.get('generated')
          ? mappedLinesForSource(
              record.maps.get('generated')!,
              location.sourceIdentity.uri,
              location.range.start.line,
            )
          : [],
    };
  }

  private createRecord(
    id: string,
    folderUri: string,
    context: IncludePointContext,
    evidence: AdapterCompilerEvidence,
  ): EvidenceRecord {
    const maps = new Map<CompilerDocumentKind, CompilerDocumentMap>();
    const virtualUris: string[] = [];
    for (const document of evidence.documents) {
      const virtualUri = compilerVirtualUri(id, document.kind);
      maps.set(
        document.kind,
        buildCompilerDocumentMap(evidence, document, virtualUri),
      );
      virtualUris.push(virtualUri);
    }
    return {
      id,
      evidence,
      folderUri,
      context: cloneContext(context),
      maps,
      virtualUris,
    };
  }

  private supersedeOlderRecords(current: EvidenceRecord): void {
    for (const record of this.records.values()) {
      if (
        record === current
        || record.staleReason
        || uriKey(record.folderUri) !== uriKey(current.folderUri)
      ) continue;
      this.markStale(record, 'superseded');
    }
  }

  private pruneRecords(current: EvidenceRecord): void {
    const retainedStalePerFolder = 1;
    const stale = [...this.records.values()].filter((record) => (
      record !== current
      && record.staleReason
      && uriKey(record.folderUri) === uriKey(current.folderUri)
    ));
    for (const record of stale.slice(0, Math.max(0, stale.length - retainedStalePerFolder))) {
      this.records.delete(record.id);
      for (const uri of record.virtualUris) this.recordByVirtualUri.delete(uri);
    }
  }

  private async currentSourcesMatch(record: EvidenceRecord): Promise<boolean> {
    for (const source of record.evidence.sources) {
      const current = await this.options.sourceText(source.identity.uri);
      if (current === undefined || sha256(current) !== source.identity.contentHash) {
        return false;
      }
    }
    return true;
  }

  private currentRecordForDiagnostic(
    diagnostic: ProfiledAdapterDiagnostic,
  ): EvidenceRecord | undefined {
    const matches = [...this.records.values()].filter((record) => {
      const evidence = record.evidence.provenance;
      const message = diagnostic.provenance;
      return record.staleReason === undefined
        && message.instanceId === evidence.instanceId
        && message.projectId === evidence.projectId
        && message.adapterVersion === evidence.adapterVersion
        && message.unityVersion === evidence.unityVersion
        && uriKey(message.sourceRevision.uri) === uriKey(evidence.sourceRevision.uri)
        && message.sourceRevision.contentHash === evidence.sourceRevision.contentHash
        && sameProfile(diagnostic.profile, evidence.profile);
    });
    return matches.sort((left, right) => (
      right.evidence.provenance.collectedAt - left.evidence.provenance.collectedAt
    ))[0];
  }

  private handleAdapterStatus(status: AdapterStatus): void {
    const reason: CompilerEvidenceStaleReason = status.mode === 'standalone'
      ? 'adapter-disconnected'
      : 'adapter-reconnected';
    for (const record of this.records.values()) this.markStale(record, reason);
  }

  private markStale(record: EvidenceRecord, reason: CompilerEvidenceStaleReason): void {
    if (record.staleReason) return;
    record.staleReason = reason;
    this.publish(record.virtualUris);
  }

  private publish(uris: readonly string[]): void {
    for (const listener of [...this.listeners]) listener(uris);
  }
}

function viewsResult(record: EvidenceRecord): CompilerViewsResult {
  return {
    status: 'available',
    evidenceId: record.id,
    sourceUri: record.context.shaderUri,
    contextId: record.context.id,
    profile: { ...record.evidence.provenance.profile },
    stale: record.staleReason !== undefined,
    ...(record.staleReason ? { staleReason: record.staleReason } : {}),
    views: [...record.maps.values()].map((map) => ({
      kind: map.kind,
      uri: map.virtualUri,
    })),
    provenance: record.evidence.provenance,
  };
}

function renderVirtualDocument(record: EvidenceRecord, map: CompilerDocumentMap): string {
  const status = record.staleReason
    ? `STALE (${record.staleReason}) — navigation disabled`
    : 'CURRENT';
  const provenance = record.evidence.provenance;
  return [
    `// UnityShaderNav ${map.kind.toUpperCase()} evidence — ${status}`,
    `// Context ${provenance.contextId} | Unity ${provenance.unityVersion} | Adapter ${provenance.adapterVersion} | Profile ${provenance.profile.name}`,
    map.rawText,
  ].join('\n');
}

function compilerVirtualUri(id: string, kind: CompilerDocumentKind): string {
  return `unity-shader-nav-compiler://evidence/${id}/${kind}.hlsl`;
}

function kindForVirtualUri(uri: string): CompilerDocumentKind {
  return /\/preprocessed\.hlsl(?:$|[?#])/.test(uri) ? 'preprocessed' : 'generated';
}

function evidenceIdentity(evidence: AdapterCompilerEvidence): string {
  return createHash('sha256').update(JSON.stringify({
    provenance: evidence.provenance,
    sources: evidence.sources.map((source) => source.identity),
    documents: evidence.documents.map((document) => ({
      kind: document.kind,
      compilerPath: document.compilerPath ?? null,
      contentHash: sha256(document.text),
    })),
  }), 'utf8').digest('hex');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameProfile(left: CompileProfile, right: CompileProfile): boolean {
  return left.name === right.name
    && left.platform === right.platform
    && left.graphicsApi === right.graphicsApi
    && left.capability === right.capability;
}

function cloneContext(context: IncludePointContext): IncludePointContext {
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

function lineRange(line: number, length: number): Range {
  return {
    start: { line, character: 0 },
    end: { line, character: Math.max(0, length) },
  };
}

function dedupeLocations(
  locations: readonly CompilerMappedLocation[],
): readonly CompilerMappedLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = [
      location.uri,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
