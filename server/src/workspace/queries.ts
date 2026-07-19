import {
  DocumentHighlightKind,
  SemanticTokensBuilder,
  SymbolKind as LspSymbolKind,
  type CompletionItem,
  type CancellationToken,
  type DocumentHighlight,
  type DocumentSymbol,
  type Hover,
  type SemanticTokens,
  type SignatureHelp,
  type SymbolInformation,
} from 'vscode-languageserver/node';
import type {
  FileIndex,
  Range,
  ReferenceEntry,
  SymbolEntry,
  SymbolKind,
} from '@unity-shader-nav/shared';
import type { DocumentAnalysis, DocumentLexicalToken } from '../analysis';
import { shaderLabSnippetCompletions } from '../authoring';
import type { DocumentationResolver } from '../documentation';
import type { IncludeChain } from '../include';
import {
  awaitWithRequestCancellation,
  cooperativeRequestCheckpoint,
  throwIfRequestCancelled,
} from '../lifecycle/requestCancellation';
import { formatHoverCandidates, type HoverInput } from '../hover';
import {
  cursorTargetAt,
  findHighlights,
  resolveDefinitionSymbols,
  resolveMemberSymbols,
} from '../index';
import { buildDocumentSymbols } from '../index/documentSymbols';
import { HIDDEN_SYMBOL_KINDS, SYMBOL_KIND_MAP } from '../index/symbolKindMap';
import {
  isGenericDefinitionContext,
  isGenericDefinitionCursor,
} from '../parser/lexical/context';
import {
  callContextAt,
  suggestionContextAt,
  suggestionContextFromCursor,
  toCompletionItem,
  toSignatureInformation,
  type SuggestionCandidateSelector,
} from '../suggestions';
import type { PackageContext } from '../packages';
import { rangeKey, uriBasename } from '../sourceLocation';
import type {
  DocumentPositionInput,
  IndexedDocumentQueryInput,
} from './indexedWorkspace';
import type { CursorRequestFacts } from './requestFacts';
import type { WorkspaceIndexReadView } from './workspaceIndex';
import { SEMANTIC_TOKEN_TYPES } from './semanticTokenLegend';
import { variantContextStore } from './variantContextStore';
import {
  completeShaderLabName,
  shaderLabNameDefinitions,
  type ShaderLabNameState,
  shaderLabNameCompletionContext,
  shaderLabNameHover,
  shaderLabNameTargetAt,
  shaderLabWorkspaceSymbols,
  shaderLabWorkspaceSymbolsCooperatively,
} from './shaderLabNames';

export { SEMANTIC_TOKEN_TYPES } from './semanticTokenLegend';

export interface WorkspaceQueryState {
  readonly folderUri: string;
  readonly index: WorkspaceIndexReadView;
  readonly packages: PackageContext;
  readonly includeChain: IncludeChain;
  readonly includePackages: boolean;
  readonly suggestionCandidates: SuggestionCandidateSelector;
  readonly documentation: DocumentationResolver;
}

const NO_VISIBLE_URIS: ReadonlySet<string> = new Set();

type SuggestionWorkspaceQueryState = Pick<
  WorkspaceQueryState,
  'suggestionCandidates'
>;

function shaderLabNameState(state: WorkspaceQueryState): ShaderLabNameState {
  return {
    index: state.index,
    isInPackages: (uri) => state.packages.isInPackages(uri),
    includePackages: state.includePackages,
  };
}

/** Preserve completion's lexical early exit without publishing a document index. */
export function completionWithoutIndex(
  input: DocumentPositionInput,
  facts?: CursorRequestFacts,
): CompletionItem[] | undefined {
  const { document, position } = input;
  const context = facts
    ? suggestionContextFromCursor(facts.cursor)
    : suggestionContextAt(document.text, position, document.languageId, document.uri);
  if (shaderLabNameCompletionContext(facts?.source ?? document.text, position)) return undefined;
  return context.kind === 'comment' || context.kind === 'string' ? [] : undefined;
}

/** Signature Help needs an index only for a syntactically eligible call site. */
export function signatureHelpNeedsIndex(
  input: DocumentPositionInput,
  facts?: CursorRequestFacts,
): boolean {
  const { document, position } = input;
  const context = facts
    ? suggestionContextFromCursor(facts.cursor)
    : suggestionContextAt(document.text, position, document.languageId, document.uri);
  return context.kind !== 'comment'
    && context.kind !== 'string'
    && context.kind !== 'shaderLabCode'
    && (facts?.call() ?? callContextAt(document.text, position)) !== null;
}

export async function queryHover(
  state: WorkspaceQueryState,
  input: DocumentPositionInput,
  lexicalTokens?: readonly DocumentLexicalToken[],
  facts?: CursorRequestFacts,
): Promise<Hover | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position } = input;
  const index = state.index.store.get(document.uri);
  if (!index) return null;
  const shaderLabNameTarget = shaderLabNameTargetAt(index, position);
  if (shaderLabNameTarget) {
    return shaderLabNameDefinitions(
      shaderLabNameState(state),
      shaderLabNameTarget,
    ).length > 0
      ? shaderLabNameHover(shaderLabNameTarget)
      : null;
  }
  let declarations: SymbolEntry[] = [];
  let visibleUriKeys = NO_VISIBLE_URIS;
  const genericContext = facts
    ? isGenericDefinitionCursor(facts.cursor)
    : isGenericDefinitionContext(
      document.text,
      position,
      document.languageId,
      document.uri,
    );
  if (genericContext) {
    const target = facts?.target({ detectIncludes: false })
      ?? cursorTargetAt(document.text, position, { detectIncludes: false });
    if (target.kind === 'member' || target.kind === 'symbol') {
      visibleUriKeys = await awaitWithRequestCancellation(
        state.includeChain.visibleUriKeys(document.uri),
        input.cancellation,
      );
      const options = { visibleUriKeys };
      if (target.kind === 'member') {
        declarations = resolveMemberSymbols(
          index,
          state.index.global,
          target.receiver.text,
          target.member.text,
          position,
          options,
        );
      }
      if (declarations.length === 0) {
        const word = target.kind === 'member' ? target.member : target.word;
        declarations = resolveDefinitionSymbols(
          index,
          word.text,
          position,
          state.index.global,
          options,
        );
      }
    }
  }

  const resolution = state.documentation.resolve({
    text: document.text,
    source: facts?.source,
    cursor: facts?.cursor,
    position,
    languageId: document.languageId,
    uri: document.uri,
    lexicalTokens,
    declarations,
    visibleUriKeys,
  });
  throwIfRequestCancelled(input.cancellation);
  if (!resolution) return null;
  const contents = formatHoverCandidates(resolution.candidates.map((candidate): HoverInput => (
    candidate.source === 'project'
      ? {
        source: 'project',
        symbol: candidate.symbol,
        workspaceRootUri: state.folderUri,
        package: candidate.package,
      }
      : candidate
  )));
  return contents.value.length > 0 ? { contents, range: resolution.range } : null;
}

export async function queryCompletion(
  state: WorkspaceQueryState,
  input: DocumentPositionInput,
  analysis?: DocumentAnalysis,
  facts?: CursorRequestFacts,
): Promise<CompletionItem[] | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position } = input;
  const shaderLabNames = completeShaderLabName(
    shaderLabNameState(state),
    facts?.source ?? document.text,
    position,
  );
  if (shaderLabNames !== null) return shaderLabNames;
  const context = facts
    ? suggestionContextFromCursor(facts.cursor)
    : suggestionContextAt(document.text, position, document.languageId, document.uri);
  if (context.kind === 'comment' || context.kind === 'string') return [];
  const snippets = shaderLabSnippetCompletions(
    analysis,
    document.text,
    position,
    document.languageId,
    document.uri,
    facts?.cursor,
  );
  const selection = await state.suggestionCandidates.select({
    uri: document.uri,
    position,
    cancellation: input.cancellation,
    query: context.member
      ? {
        kind: 'member',
        receiver: context.member.receiver,
        prefix: context.member.memberPrefix.text,
      }
      : { kind: 'completion', context },
  });
  if (!selection) return snippets.length > 0 ? snippets : null;
  const items: CompletionItem[] = [];
  let processed = 0;
  for (const suggestion of selection.suggestions) {
    items.push(toCompletionItem(suggestion));
    const checkpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
    if (checkpoint) await checkpoint;
  }
  return [...items, ...snippets];
}

export async function querySignatureHelp(
  state: SuggestionWorkspaceQueryState,
  input: DocumentPositionInput,
  facts?: CursorRequestFacts,
): Promise<SignatureHelp | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position } = input;
  const context = facts
    ? suggestionContextFromCursor(facts.cursor)
    : suggestionContextAt(document.text, position, document.languageId, document.uri);
  if (context.kind === 'comment' || context.kind === 'string' || context.kind === 'shaderLabCode') {
    return null;
  }
  const call = facts?.call() ?? callContextAt(document.text, position);
  if (!call) return null;
  const selection = await state.suggestionCandidates.select({
    uri: document.uri,
    position,
    cancellation: input.cancellation,
    query: {
      kind: 'signature',
      context,
      target: call.target,
      activeParameter: call.activeParameter,
    },
  });
  if (!selection) return null;
  const signatures: NonNullable<ReturnType<typeof toSignatureInformation>>[] = [];
  let processed = 0;
  for (const suggestion of selection.suggestions) {
    const signature = toSignatureInformation(suggestion);
    if (signature) signatures.push(signature);
    const checkpoint = cooperativeRequestCheckpoint(++processed, input.cancellation);
    if (checkpoint) await checkpoint;
  }
  if (signatures.length === 0) return null;
  const activeSignature = Math.min(
    selection.activeSuggestion ?? 0,
    signatures.length - 1,
  );
  const maxParameterIndex = Math.max(
    0,
    (signatures[activeSignature]?.parameters?.length ?? 0) - 1,
  );
  return {
    signatures,
    activeSignature,
    activeParameter: Math.min(call.activeParameter, maxParameterIndex),
  };
}

export async function queryHighlights(
  state: WorkspaceQueryState,
  input: DocumentPositionInput,
  facts?: CursorRequestFacts,
): Promise<DocumentHighlight[] | null> {
  throwIfRequestCancelled(input.cancellation);
  const { document, position } = input;
  const index = state.index.store.get(document.uri);
  if (!index) return null;
  const genericContext = facts
    ? isGenericDefinitionCursor(facts.cursor)
    : isGenericDefinitionContext(document.text, position, document.languageId, document.uri);
  if (!genericContext) {
    return null;
  }
  const target = facts?.target({ detectIncludes: false })
    ?? cursorTargetAt(document.text, position, { detectIncludes: false });
  if (target.kind === 'none') return null;
  const visibleUriKeys = await awaitWithRequestCancellation(
    state.includeChain.visibleUriKeys(document.uri),
    input.cancellation,
  );
  const highlights = findHighlights(target, {
    index,
    position,
    global: state.index.global,
    options: { visibleUriKeys },
    cancellation: input.cancellation,
    variantContext: variantContextStore.get(document.uri) ?? undefined,
    getText: (uri: string) => (uri === document.uri ? document.text : undefined),
    isShaderLab: /\.shader(?:$|[?#])/i.test(document.uri),
  }).map((location): DocumentHighlight => ({
    range: location.range,
    kind: DocumentHighlightKind.Text,
  }));
  return highlights.length > 0 ? highlights : null;
}

export function queryDocumentSymbols(
  state: WorkspaceQueryState,
  input: IndexedDocumentQueryInput,
): DocumentSymbol[] | null {
  throwIfRequestCancelled(input.cancellation);
  const index = state.index.store.get(input.uri);
  const result = index ? buildDocumentSymbols(index) : null;
  throwIfRequestCancelled(input.cancellation);
  return result;
}

export async function querySemanticTokens(
  state: WorkspaceQueryState,
  input: IndexedDocumentQueryInput,
  lexicalTokens?: readonly DocumentLexicalToken[],
): Promise<SemanticTokens> {
  throwIfRequestCancelled(input.cancellation);
  const index = state.index.store.get(input.uri);
  return index
    ? await semanticTokensForIndex(index, state.index.global, lexicalTokens, input.cancellation)
    : { data: [] };
}

export function queryWorkspaceSymbols(
  state: WorkspaceQueryState,
  query: string,
): SymbolInformation[];
export function queryWorkspaceSymbols(
  state: WorkspaceQueryState,
  query: string,
  cancellation: CancellationToken,
): Promise<SymbolInformation[]>;
export function queryWorkspaceSymbols(
  state: WorkspaceQueryState,
  query: string,
  cancellation?: CancellationToken,
): SymbolInformation[] | Promise<SymbolInformation[]> {
  return cancellation
    ? queryWorkspaceSymbolsCooperatively(state, query, cancellation)
    : queryWorkspaceSymbolsSynchronously(state, query);
}

function queryWorkspaceSymbolsSynchronously(
  state: WorkspaceQueryState,
  query: string,
): SymbolInformation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: SymbolEntry[] = [];
  for (const entry of state.index.global.entries()) {
    if (matchesWorkspaceSymbolQuery(state, entry, needle)) matches.push(entry);
  }
  return workspaceSymbolResults(state, query, matches);
}

async function queryWorkspaceSymbolsCooperatively(
  state: WorkspaceQueryState,
  query: string,
  cancellation: CancellationToken,
): Promise<SymbolInformation[]> {
  throwIfRequestCancelled(cancellation);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: SymbolEntry[] = [];
  let processed = 0;
  for (const entry of state.index.global.entries()) {
    const checkpoint = cooperativeRequestCheckpoint(++processed, cancellation);
    if (checkpoint) await checkpoint;
    if (matchesWorkspaceSymbolQuery(state, entry, needle)) matches.push(entry);
  }
  const shaderLabMatches = await shaderLabWorkspaceSymbolsCooperatively(
    shaderLabNameState(state),
    query,
    () => cooperativeRequestCheckpoint(++processed, cancellation),
  );
  const hlslMatches: SymbolInformation[] = [];
  for (const match of matches) {
    const checkpoint = cooperativeRequestCheckpoint(++processed, cancellation);
    if (checkpoint) await checkpoint;
    hlslMatches.push(toSymbolInformation(match));
  }
  throwIfRequestCancelled(cancellation);
  const result = [...hlslMatches, ...shaderLabMatches].sort(compareWorkspaceSymbols);
  throwIfRequestCancelled(cancellation);
  return result;
}

function matchesWorkspaceSymbolQuery(
  state: WorkspaceQueryState,
  entry: SymbolEntry,
  needle: string,
): boolean {
  if (HIDDEN_SYMBOL_KINDS.has(entry.kind)) return false;
  if (!entry.name.trim()) return false;
  if (!state.includePackages && state.packages.isInPackages(entry.location.uri)) return false;
  return entry.name.toLowerCase().includes(needle);
}

function workspaceSymbolResults(
  state: WorkspaceQueryState,
  query: string,
  matches: SymbolEntry[],
): SymbolInformation[] {
  return sortWorkspaceSymbolResults(
    matches,
    shaderLabWorkspaceSymbols(shaderLabNameState(state), query),
  );
}

function sortWorkspaceSymbolResults(
  matches: SymbolEntry[],
  shaderLabMatches: SymbolInformation[],
): SymbolInformation[] {
  return [
    ...matches.sort(compareEntries).map(toSymbolInformation),
    ...shaderLabMatches,
  ].sort(compareWorkspaceSymbols);
}

export function compareWorkspaceSymbols(
  left: SymbolInformation,
  right: SymbolInformation,
): number {
  return left.name.localeCompare(right.name)
    || left.location.uri.localeCompare(right.location.uri)
    || left.location.range.start.line - right.location.range.start.line
    || left.location.range.start.character - right.location.range.start.character;
}

function containerNameFor(symbol: SymbolEntry): string | undefined {
  if (symbol.parentType) return symbol.parentType;
  return uriBasename(symbol.location.uri);
}

function compareEntries(left: SymbolEntry, right: SymbolEntry): number {
  return left.name.localeCompare(right.name)
    || left.location.uri.localeCompare(right.location.uri)
    || left.location.range.start.line - right.location.range.start.line
    || left.location.range.start.character - right.location.range.start.character;
}

function toSymbolInformation(symbol: SymbolEntry): SymbolInformation {
  return {
    name: symbol.name,
    kind: SYMBOL_KIND_MAP[symbol.kind] ?? LspSymbolKind.Object,
    location: symbol.location,
    containerName: containerNameFor(symbol),
  };
}

const TOKEN_TYPE_INDEX = new Map<string, number>(
  SEMANTIC_TOKEN_TYPES.map((tokenType, index) => [tokenType, index]),
);
type SemanticTokenType = typeof SEMANTIC_TOKEN_TYPES[number];
interface TokenRange {
  range: Range;
  tokenType: SemanticTokenType;
}
interface SymbolLookup {
  lookup(name: string): SymbolEntry[];
}
const TOKEN_PRIORITY: Record<SemanticTokenType, number> = {
  enumMember: 0,
  macro: 1,
  type: 2,
  property: 3,
  function: 4,
  keyword: 5,
  decorator: 6,
  string: 7,
  number: 8,
  parameter: 9,
  variable: 10,
  operator: 11,
};

function symbolTokenType(kind: SymbolKind): SemanticTokenType {
  switch (kind) {
    case 'struct': return 'type';
    case 'structMember': return 'property';
    case 'function': return 'function';
    case 'macro': return 'macro';
    case 'parameter': return 'parameter';
    case 'variable':
    case 'localVariable':
    case 'cbuffer': return 'variable';
  }
}

function referenceTokenType(
  reference: ReferenceEntry,
  macroNames: ReadonlySet<string>,
): SemanticTokenType | undefined {
  switch (reference.context) {
    case 'type': return 'type';
    case 'member': return 'property';
    case 'call':
    case 'pragma': return macroNames.has(reference.name) ? 'macro' : 'function';
    case 'identifier': return 'variable';
    case 'include': return undefined;
  }
}

async function semanticTokensForIndex(
  index: FileIndex,
  global?: SymbolLookup,
  lexicalTokens?: readonly DocumentLexicalToken[],
  cancellation?: CancellationToken,
): Promise<SemanticTokens> {
  const macroNames = new Set<string>();
  const progress = { processed: 0 };
  for (const symbol of index.symbols) {
    const checkpoint = semanticTokenCheckpoint(progress, cancellation);
    if (checkpoint) await checkpoint;
    if (symbol.kind === 'macro') macroNames.add(symbol.name);
  }
  for (const reference of index.references) {
    const checkpoint = semanticTokenCheckpoint(progress, cancellation);
    if (checkpoint) await checkpoint;
    if (reference.context !== 'call' && reference.context !== 'pragma') continue;
    if (!macroNames.has(reference.name)) {
      const lookup = containsMacroSymbol(
        global?.lookup(reference.name),
        progress,
        cancellation,
      );
      const hasMacro = typeof lookup === 'boolean' ? lookup : await lookup;
      if (hasMacro) macroNames.add(reference.name);
    }
  }

  const tokens: TokenRange[] = [];
  for (const symbol of index.symbols) {
    const checkpoint = semanticTokenCheckpoint(progress, cancellation);
    if (checkpoint) await checkpoint;
    tokens.push({ range: symbol.location.range, tokenType: symbolTokenType(symbol.kind) });
  }
  for (const reference of index.references) {
    const checkpoint = semanticTokenCheckpoint(progress, cancellation);
    if (checkpoint) await checkpoint;
    const tokenType = referenceTokenType(reference, macroNames);
    if (tokenType) tokens.push({ range: reference.location.range, tokenType });
  }
  if (lexicalTokens) {
    for (const token of lexicalTokens) {
      const checkpoint = semanticTokenCheckpoint(progress, cancellation);
      if (checkpoint) await checkpoint;
      tokens.push({ range: token.range, tokenType: token.tokenType });
    }
  }

  const builder = new SemanticTokensBuilder();
  const seen = new Set<string>();
  const accepted: TokenRange[] = [];
  throwIfRequestCancelled(cancellation);
  tokens.sort(compareTokens);
  throwIfRequestCancelled(cancellation);
  for (const token of tokens) {
    const checkpoint = semanticTokenCheckpoint(progress, cancellation);
    if (checkpoint) await checkpoint;
    if (token.range.start.line !== token.range.end.line) continue;
    const key = rangeKey(token.range);
    if (seen.has(key)) continue;
    const previous = accepted.at(-1);
    if (previous && rangesOverlap(previous.range, token.range)) continue;
    const tokenType = TOKEN_TYPE_INDEX.get(token.tokenType);
    if (tokenType === undefined) continue;
    seen.add(key);
    accepted.push(token);
    builder.push(
      token.range.start.line,
      token.range.start.character,
      token.range.end.character - token.range.start.character,
      tokenType,
      0,
    );
  }
  return builder.build();
}

interface SemanticTokenProgress {
  processed: number;
}

function semanticTokenCheckpoint(
  progress: SemanticTokenProgress,
  cancellation?: CancellationToken,
): Promise<void> | undefined {
  return cooperativeRequestCheckpoint(++progress.processed, cancellation);
}

function containsMacroSymbol(
  symbols: readonly SymbolEntry[] | undefined,
  progress: SemanticTokenProgress,
  cancellation?: CancellationToken,
): boolean | Promise<boolean> {
  const candidates = symbols ?? [];
  for (let index = 0; index < candidates.length; index++) {
    const checkpoint = semanticTokenCheckpoint(progress, cancellation);
    if (checkpoint) {
      return continueContainsMacroSymbol(
        candidates,
        index,
        progress,
        cancellation,
        checkpoint,
      );
    }
    if (candidates[index].kind === 'macro') return true;
  }
  return false;
}

async function continueContainsMacroSymbol(
  symbols: readonly SymbolEntry[],
  index: number,
  progress: SemanticTokenProgress,
  cancellation: CancellationToken | undefined,
  initialCheckpoint: Promise<void>,
): Promise<boolean> {
  await initialCheckpoint;
  if (symbols[index].kind === 'macro') return true;
  for (let current = index + 1; current < symbols.length; current++) {
    const checkpoint = semanticTokenCheckpoint(progress, cancellation);
    if (checkpoint) await checkpoint;
    if (symbols[current].kind === 'macro') return true;
  }
  return false;
}

function compareTokens(left: TokenRange, right: TokenRange): number {
  return left.range.start.line - right.range.start.line
    || left.range.start.character - right.range.start.character
    || left.range.end.character - right.range.end.character
    || TOKEN_PRIORITY[left.tokenType] - TOKEN_PRIORITY[right.tokenType];
}

function rangesOverlap(left: Range, right: Range): boolean {
  if (left.start.line !== right.start.line || left.end.line !== right.end.line) return false;
  return left.start.character < right.end.character && right.start.character < left.end.character;
}
