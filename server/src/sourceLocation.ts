import type {
  Position,
  Range,
  SymbolEntry,
} from '@unity-shader-nav/shared';

/** Line facts that are valid only for the exact retained source text. */
export type ExactSourceColumnRole = 'code' | 'comment' | 'stringQuote' | 'stringBody';

export interface ExactSourceLexicalLine {
  readonly commentRoles: readonly ExactSourceColumnRole[];
  readonly lineComment: boolean;
}

export interface ExactSource {
  readonly sourceText: string;
  readonly sourceLines: readonly string[];
  readonly sourceLexicalLines?: readonly ExactSourceLexicalLine[];
  /** Incoming block-comment state for each line when full column roles are absent. */
  readonly sourceBlockCommentStates?: readonly boolean[];
}

/** Reuse prepared line facts only when they describe this exact text snapshot. */
export function exactSource(
  text: string,
  prepared?: ExactSource,
): ExactSource {
  if (prepared?.sourceText === text) return prepared;
  return Object.freeze({
    sourceText: text,
    sourceLines: text.split(/\r?\n/),
  });
}

export function textInRange(source: ExactSource, range: Range): string {
  if (range.start.line !== range.end.line) return '';
  return (source.sourceLines[range.start.line] ?? '')
    .slice(range.start.character, range.end.character);
}

export interface LocationLink {
  readonly targetUri: string;
  readonly targetRange: Range;
  readonly targetSelectionRange: Range;
  readonly originSelectionRange?: Range;
}

/** True when `position` lies within `range`, including both endpoints. */
export function containsPosition(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line && position.character > range.end.character) return false;
  return true;
}

export function isBeforeOrAt(left: Position, right: Position): boolean {
  return left.line < right.line
    || (left.line === right.line && left.character <= right.character);
}

/** Stable coordinate key. URI identity remains an explicit caller decision. */
export function rangeKey(range: Range): string {
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
}

export function locationKey(uri: string, range: Range): string {
  return `${uri}:${rangeKey(range)}`;
}

/** Decoded final path component, ignoring query/fragment metadata. */
export function uriBasename(uri: string): string | undefined {
  const withoutMetadata = uri.replace(/[?#].*$/, '');
  const lastSlash = withoutMetadata.lastIndexOf('/');
  if (lastSlash === -1 || lastSlash === withoutMetadata.length - 1) return undefined;
  const basename = withoutMetadata.slice(lastSlash + 1);
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

export function symbolToLocationLink(
  symbol: SymbolEntry,
  originSelectionRange?: Range,
): LocationLink {
  const link: LocationLink = {
    targetUri: symbol.location.uri,
    targetRange: symbol.location.range,
    targetSelectionRange: symbol.location.range,
  };
  return originSelectionRange ? { ...link, originSelectionRange } : link;
}
