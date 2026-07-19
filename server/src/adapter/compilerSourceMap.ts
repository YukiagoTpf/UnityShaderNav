import type {
  AdapterCompilerDocument,
  AdapterCompilerEvidence,
  AdapterCompilerSourceSnapshot,
  CompilerDocumentKind,
  CompilerMappedLocation,
  CompilerMappingProvenance,
  CompilerSourceIdentity,
  CompilerUnmappedReason,
  Position,
  Range,
} from '@unity-shader-nav/shared';
import { uriKey } from '../uriKey';

/** Two fixed metadata lines keep CURRENT -> STALE rendering coordinate-stable. */
export const COMPILER_DOCUMENT_HEADER_LINES = 2;

interface MappedSegment {
  readonly kind: 'mapped';
  readonly documentRange: Range;
  readonly sourceRange: Range;
  readonly sourceIdentity: CompilerSourceIdentity;
  readonly provenance: CompilerMappingProvenance;
}

interface UnmappedSegment {
  readonly kind: 'unmapped';
  readonly documentRange: Range;
  readonly reason: CompilerUnmappedReason;
}

export type CompilerMapSegment = MappedSegment | UnmappedSegment;

export interface CompilerDocumentMap {
  readonly kind: CompilerDocumentKind;
  readonly virtualUri: string;
  readonly compilerPath?: string;
  readonly rawText: string;
  readonly segments: readonly CompilerMapSegment[];
}

interface ActiveMappedSource {
  readonly kind: 'mapped';
  readonly source: AdapterCompilerSourceSnapshot;
  readonly sourceLines: readonly string[];
  readonly sourceName: string;
  readonly directiveDocumentLine: number;
  nextSourceLine: number;
}

interface ActiveUnmappedSource {
  readonly kind: 'unmapped';
  readonly reason: 'unknown-source' | 'ambiguous-source';
  nextSourceLine: number;
}

type ActiveSource = ActiveMappedSource | ActiveUnmappedSource;

interface ParsedLineDirective {
  readonly sourceLine: number;
  readonly sourceName?: string;
}

export function buildCompilerDocumentMap(
  evidence: AdapterCompilerEvidence,
  document: AdapterCompilerDocument,
  virtualUri: string,
): CompilerDocumentMap {
  const aliases = sourceAliases(evidence.sources);
  const documentLines = lines(document.text);
  const segments: CompilerMapSegment[] = [
    unmappedLine(0, metadataLineLength(document), 'evidence-metadata'),
    unmappedLine(1, metadataDetailLength(evidence), 'evidence-metadata'),
  ];
  let active: ActiveSource | undefined;

  for (let rawLine = 0; rawLine < documentLines.length; rawLine++) {
    const text = documentLines[rawLine] ?? '';
    const documentLine = rawLine + COMPILER_DOCUMENT_HEADER_LINES;
    const directive = parseLineDirective(text);
    if (directive) {
      active = activateDirective(
        directive,
        aliases,
        active,
        documentLine,
      );
      segments.push(unmappedLine(
        documentLine,
        text.length,
        'line-directive',
      ));
      continue;
    }
    if (isLineMappingReset(text)) {
      active = undefined;
      segments.push(unmappedLine(
        documentLine,
        text.length,
        'line-directive',
      ));
      continue;
    }

    if (!active) {
      segments.push(unmappedLine(documentLine, text.length, 'generated-only'));
      continue;
    }
    if (active.kind === 'unmapped') {
      active.nextSourceLine++;
      segments.push(unmappedLine(documentLine, text.length, active.reason));
      continue;
    }

    const sourceLine = active.nextSourceLine++;
    const sourceText = active.sourceLines[sourceLine];
    if (sourceText === undefined) {
      segments.push(unmappedLine(
        documentLine,
        text.length,
        'invalid-source-line',
      ));
      continue;
    }
    if (sourceText !== text) {
      // #line supplies a line association, not a character-level macro map.
      // A changed line is therefore a visible gap rather than an approximation.
      segments.push(unmappedLine(documentLine, text.length, 'macro-expansion'));
      continue;
    }

    segments.push({
      kind: 'mapped',
      documentRange: lineRange(documentLine, text.length),
      sourceRange: lineRange(sourceLine, sourceText.length),
      sourceIdentity: { ...active.source.identity },
      provenance: {
        method: 'line-directive',
        granularity: 'line',
        evidence: evidence.provenance,
        directive: {
          documentLine: active.directiveDocumentLine,
          sourceLine,
          sourceName: active.sourceName,
        },
      },
    });
  }

  return {
    kind: document.kind,
    virtualUri,
    ...(document.compilerPath ? { compilerPath: document.compilerPath } : {}),
    rawText: document.text,
    segments,
  };
}

export function mapFromCompilerDocument(
  map: CompilerDocumentMap,
  position: Position,
): {
  readonly locations: readonly CompilerMappedLocation[];
  readonly unmappedReason?: CompilerUnmappedReason;
} {
  const segment = map.segments.find(({ documentRange }) => (
    rangeContains(documentRange, position)
  ));
  if (!segment) return { locations: [], unmappedReason: 'no-reliable-mapping' };
  if (segment.kind === 'unmapped') {
    return { locations: [], unmappedReason: segment.reason };
  }
  return {
    locations: [{
      uri: segment.sourceIdentity.uri,
      range: projectRange(position, segment.documentRange, segment.sourceRange),
      sourceIdentity: { ...segment.sourceIdentity },
      provenance: segment.provenance,
    }],
  };
}

export function mapToCompilerDocument(
  map: CompilerDocumentMap,
  sourceUri: string,
  position: Position,
): readonly CompilerMappedLocation[] {
  const sourceKey = uriKey(sourceUri);
  return map.segments.flatMap((segment): CompilerMappedLocation[] => {
    if (
      segment.kind !== 'mapped'
      || uriKey(segment.sourceIdentity.uri) !== sourceKey
      || !rangeContains(segment.sourceRange, position)
    ) return [];
    return [{
      uri: map.virtualUri,
      range: projectRange(position, segment.sourceRange, segment.documentRange),
      sourceIdentity: { ...segment.sourceIdentity },
      provenance: segment.provenance,
    }];
  });
}

export function mappedLinesForSource(
  map: CompilerDocumentMap,
  sourceUri: string,
  sourceLine: number,
): readonly CompilerMappedLocation[] {
  const sourceKey = uriKey(sourceUri);
  return map.segments.flatMap((segment): CompilerMappedLocation[] => {
    if (
      segment.kind !== 'mapped'
      || uriKey(segment.sourceIdentity.uri) !== sourceKey
      || segment.sourceRange.start.line !== sourceLine
    ) return [];
    return [{
      uri: map.virtualUri,
      range: cloneRange(segment.documentRange),
      sourceIdentity: { ...segment.sourceIdentity },
      provenance: segment.provenance,
    }];
  });
}

export function rawDocumentPosition(line: number, character = 0): Position {
  return {
    line: line + COMPILER_DOCUMENT_HEADER_LINES,
    character,
  };
}

function sourceAliases(
  sources: readonly AdapterCompilerSourceSnapshot[],
): ReadonlyMap<string, readonly AdapterCompilerSourceSnapshot[]> {
  const result = new Map<string, AdapterCompilerSourceSnapshot[]>();
  for (const source of sources) {
    for (const name of source.lineDirectiveNames) {
      const matches = result.get(name) ?? [];
      matches.push(source);
      result.set(name, matches);
    }
  }
  return result;
}

function activateDirective(
  directive: ParsedLineDirective,
  aliases: ReadonlyMap<string, readonly AdapterCompilerSourceSnapshot[]>,
  previous: ActiveSource | undefined,
  documentLine: number,
): ActiveSource | undefined {
  const nextSourceLine = directive.sourceLine;
  if (directive.sourceName === undefined) {
    if (!previous) return undefined;
    if (previous.kind === 'mapped') {
      return { ...previous, nextSourceLine, directiveDocumentLine: documentLine };
    }
    return { ...previous, nextSourceLine };
  }

  const matches = aliases.get(directive.sourceName) ?? [];
  if (matches.length !== 1) {
    return {
      kind: 'unmapped',
      reason: matches.length === 0 ? 'unknown-source' : 'ambiguous-source',
      nextSourceLine,
    };
  }
  return {
    kind: 'mapped',
    source: matches[0]!,
    sourceLines: lines(matches[0]!.text),
    sourceName: directive.sourceName,
    directiveDocumentLine: documentLine,
    nextSourceLine,
  };
}

function parseLineDirective(text: string): ParsedLineDirective | undefined {
  const match = /^\s*#\s*(?:line\s+)?(\d+)(?:\s+"([^"]+)")?(?:\s.*)?$/.exec(text);
  if (!match) return undefined;
  const oneBasedLine = Number(match[1]);
  if (!Number.isSafeInteger(oneBasedLine) || oneBasedLine < 1) return undefined;
  return {
    sourceLine: oneBasedLine - 1,
    ...(match[2] !== undefined ? { sourceName: match[2] } : {}),
  };
}

function isLineMappingReset(text: string): boolean {
  return /^\s*#\s*line\s+(?:default|hidden)(?:\s|$)/.test(text);
}

function lines(text: string): readonly string[] {
  return text.split(/\r\n|\r|\n/);
}

function unmappedLine(
  line: number,
  length: number,
  reason: CompilerUnmappedReason,
): UnmappedSegment {
  return { kind: 'unmapped', documentRange: lineRange(line, length), reason };
}

function lineRange(line: number, length: number): Range {
  return {
    start: { line, character: 0 },
    end: { line, character: Math.max(0, length) },
  };
}

function rangeContains(range: Range, position: Position): boolean {
  if (range.start.line !== position.line || range.end.line !== position.line) return false;
  return position.character >= range.start.character
    && position.character <= range.end.character;
}

function projectRange(
  position: Position,
  from: Range,
  to: Range,
): Range {
  const offset = Math.max(0, position.character - from.start.character);
  const character = Math.min(to.end.character, to.start.character + offset);
  return {
    start: { line: to.start.line, character },
    end: { line: to.start.line, character },
  };
}

function cloneRange(range: Range): Range {
  return {
    start: { ...range.start },
    end: { ...range.end },
  };
}

function metadataLineLength(
  document: AdapterCompilerDocument,
): number {
  return `// UnityShaderNav ${document.kind.toUpperCase()} evidence — CURRENT`.length;
}

function metadataDetailLength(evidence: AdapterCompilerEvidence): number {
  const { provenance } = evidence;
  return [
    '// Context ',
    provenance.contextId,
    ' | Unity ',
    provenance.unityVersion,
    ' | Adapter ',
    provenance.adapterVersion,
    ' | Profile ',
    provenance.profile.name,
  ].join('').length;
}
