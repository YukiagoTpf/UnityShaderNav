import {
  DocumentHighlightKind,
  SemanticTokensBuilder,
  SymbolKind as LspSymbolKind,
  type CompletionItem,
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
import type { DocumentLexicalToken } from '../analysis';
import {
  documentationTargetAt,
  type DocumentationResolver,
  type DocumentationTarget,
} from '../documentation';
import type { IncludeChain } from '../include';
import { formatHoverCandidates, type HoverInput } from '../hover';
import {
  cursorTargetAt,
  findHighlights,
  resolveDefinitionSymbols,
  resolveMemberSymbols,
} from '../index';
import { buildDocumentSymbols } from '../index/documentSymbols';
import { HIDDEN_SYMBOL_KINDS, SYMBOL_KIND_MAP } from '../index/symbolKindMap';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import {
  callContextAt,
  suggestionContextAt,
  toCompletionItem,
  toSignatureInformation,
  type SuggestionCandidateSelector,
} from '../suggestions';
import { findBuiltinEntries } from '../vocabulary';
import type { PackageContext } from '../packages';
import type {
  DocumentPositionInput,
  IndexedDocumentQueryInput,
} from './indexedWorkspace';
import type { WorkspaceIndexReadView } from './workspaceIndex';
import { SEMANTIC_TOKEN_TYPES } from './semanticTokenLegend';
import {
  completeShaderLabName,
  shaderLabNameDefinitions,
  type ShaderLabNameState,
  shaderLabNameCompletionContext,
  shaderLabNameHover,
  shaderLabNameTargetAt,
  shaderLabWorkspaceSymbols,
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
): CompletionItem[] | undefined {
  const { document, position } = input;
  const context = suggestionContextAt(
    document.text,
    position,
    document.languageId,
    document.uri,
  );
  if (shaderLabNameCompletionContext(document.text, position)) return undefined;
  return context.kind === 'comment' || context.kind === 'string' ? [] : undefined;
}

/** Signature Help needs an index only for a syntactically eligible call site. */
export function signatureHelpNeedsIndex(input: DocumentPositionInput): boolean {
  const { document, position } = input;
  const context = suggestionContextAt(
    document.text,
    position,
    document.languageId,
    document.uri,
  );
  return context.kind !== 'comment'
    && context.kind !== 'string'
    && context.kind !== 'shaderLabCode'
    && callContextAt(document.text, position) !== null;
}

export async function queryHover(
  state: WorkspaceQueryState,
  input: DocumentPositionInput,
  lexicalTokens?: readonly DocumentLexicalToken[],
): Promise<Hover | null> {
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
  const documentationTarget = documentationTargetAt(
    document.text,
    position,
    document.languageId,
    document.uri,
    lexicalTokens,
  );
  if (documentationTarget && documentationTarget.role !== 'hlslIdentifier') {
    const curated = state.documentation.curated(
      entriesForDocumentationTarget(documentationTarget),
      new Set(),
    );
    if (curated.length > 0) {
      const contents = formatHoverCandidates(curated.map(({ entry, package: pkg }): HoverInput => ({
        source: 'builtin',
        entry,
        package: pkg,
      })));
      return { contents, range: documentationTarget.range };
    }
    if (documentationTarget.role !== 'semantic') return null;
  }
  if (!isGenericDefinitionContext(document.text, position, document.languageId, document.uri)) {
    return null;
  }

  const target = cursorTargetAt(document.text, position, { detectIncludes: false });
  if (target.kind === 'none') return null;
  const visibleUriKeys = await state.includeChain.visibleUriKeys(document.uri);
  const options = { visibleUriKeys };

  if (target.kind === 'member') {
    const symbols = resolveMemberSymbols(
      index,
      state.index.global,
      target.receiver.text,
      target.member.text,
      position,
      options,
    );
    if (symbols.length > 0) {
      const contents = formatHoverCandidates(symbols.map((symbol): HoverInput => ({
        source: 'project',
        symbol,
        workspaceRootUri: state.folderUri,
        package: state.documentation.projectProvenance(symbol),
      })));
      return contents.value.length > 0
        ? { contents, range: target.member.range }
        : null;
    }
  }

  if (target.kind !== 'member' && target.kind !== 'symbol') return null;
  const word = target.kind === 'member' ? target.member : target.word;
  const projectSymbols = resolveDefinitionSymbols(
    index,
    word.text,
    position,
    state.index.global,
    options,
  );
  if (projectSymbols.length > 0) {
    const contents = formatHoverCandidates(projectSymbols.map((symbol): HoverInput => ({
      source: 'project',
      symbol,
      workspaceRootUri: state.folderUri,
      package: state.documentation.projectProvenance(symbol),
    })));
    return contents.value.length > 0 ? { contents, range: word.range } : null;
  }

  const builtins = state.documentation.curated(
    documentationTarget
      ? entriesForDocumentationTarget(documentationTarget)
      : findBuiltinEntries(word.text),
    visibleUriKeys,
  );
  if (builtins.length === 0) return null;
  const contents = formatHoverCandidates(builtins.map(({ entry, package: pkg }): HoverInput => ({
    source: 'builtin',
    entry,
    package: pkg,
  })));
  return contents.value.length > 0 ? { contents, range: word.range } : null;
}

function entriesForDocumentationTarget(target: DocumentationTarget): readonly import('../vocabulary').BuiltinEntry[] {
  return findBuiltinEntries(target.name).filter((entry) => {
    switch (target.role) {
      case 'shaderLabTerm':
        return entry.quickDocumentation !== undefined
          && (entry.roles?.includes('shaderLabKeyword') === true
            || entry.roles?.includes('shaderLabRenderState') === true);
      case 'renderStateValue':
        return entry.quickDocumentation !== undefined
          && entry.roles?.includes('shaderLabStateValue') === true;
      case 'propertyAttribute':
        return entry.quickDocumentation !== undefined
          && entry.roles?.includes('shaderLabPropertyAttribute') === true;
      case 'propertyType':
        return entry.quickDocumentation !== undefined
          && entry.roles?.includes('shaderLabPropertyType') === true;
      case 'semantic':
        return entry.category === 'semantic';
      case 'hlslIdentifier':
        return entry.category !== 'shaderlab' && entry.category !== 'semantic';
    }
  });
}

export async function queryCompletion(
  state: WorkspaceQueryState,
  input: DocumentPositionInput,
): Promise<CompletionItem[] | null> {
  const { document, position } = input;
  const shaderLabNames = completeShaderLabName(
    shaderLabNameState(state),
    document.text,
    position,
  );
  if (shaderLabNames !== null) return shaderLabNames;
  const context = suggestionContextAt(
    document.text,
    position,
    document.languageId,
    document.uri,
  );
  if (context.kind === 'comment' || context.kind === 'string') return [];
  const selection = await state.suggestionCandidates.select({
    uri: document.uri,
    position,
    query: context.member
      ? {
        kind: 'member',
        receiver: context.member.receiver,
        prefix: context.member.memberPrefix.text,
      }
      : { kind: 'completion', context },
  });
  return selection
    ? selection.suggestions.map(toCompletionItem)
    : null;
}

export async function querySignatureHelp(
  state: SuggestionWorkspaceQueryState,
  input: DocumentPositionInput,
): Promise<SignatureHelp | null> {
  const { document, position } = input;
  const context = suggestionContextAt(
    document.text,
    position,
    document.languageId,
    document.uri,
  );
  if (context.kind === 'comment' || context.kind === 'string' || context.kind === 'shaderLabCode') {
    return null;
  }
  const call = callContextAt(document.text, position);
  if (!call) return null;
  const selection = await state.suggestionCandidates.select({
    uri: document.uri,
    position,
    query: {
      kind: 'signature',
      context,
      name: call.calleeName,
      activeParameter: call.activeParameter,
    },
  });
  if (!selection) return null;
  const signatures = selection.suggestions
    .map(toSignatureInformation)
    .filter((signature): signature is NonNullable<typeof signature> => signature !== null);
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
): Promise<DocumentHighlight[] | null> {
  const { document, position } = input;
  const index = state.index.store.get(document.uri);
  if (!index) return null;
  if (!isGenericDefinitionContext(document.text, position, document.languageId, document.uri)) {
    return null;
  }
  const target = cursorTargetAt(document.text, position, { detectIncludes: false });
  if (target.kind === 'none') return null;
  const visibleUriKeys = await state.includeChain.visibleUriKeys(document.uri);
  const highlights = findHighlights(target, {
    index,
    position,
    global: state.index.global,
    options: { visibleUriKeys },
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
  const index = state.index.store.get(input.uri);
  return index ? buildDocumentSymbols(index) : null;
}

export function querySemanticTokens(
  state: WorkspaceQueryState,
  input: IndexedDocumentQueryInput,
  lexicalTokens?: readonly DocumentLexicalToken[],
): SemanticTokens {
  const index = state.index.store.get(input.uri);
  return index
    ? semanticTokensForIndex(index, state.index.global, lexicalTokens)
    : { data: [] };
}

export function queryWorkspaceSymbols(
  state: WorkspaceQueryState,
  query: string,
): SymbolInformation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: SymbolEntry[] = [];
  for (const entry of state.index.global.entries()) {
    if (HIDDEN_SYMBOL_KINDS.has(entry.kind)) continue;
    if (!entry.name.trim()) continue;
    if (!state.includePackages && state.packages.isInPackages(entry.location.uri)) continue;
    if (entry.name.toLowerCase().includes(needle)) matches.push(entry);
  }
  return [
    ...matches.sort(compareEntries).map(toSymbolInformation),
    ...shaderLabWorkspaceSymbols(shaderLabNameState(state), query),
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

function basenameFromUri(uri: string): string | undefined {
  const withoutQuery = uri.split('?', 1)[0].split('#', 1)[0];
  const lastSlash = withoutQuery.lastIndexOf('/');
  if (lastSlash === -1 || lastSlash === withoutQuery.length - 1) return undefined;
  try {
    return decodeURIComponent(withoutQuery.slice(lastSlash + 1));
  } catch {
    return withoutQuery.slice(lastSlash + 1);
  }
}

function containerNameFor(symbol: SymbolEntry): string | undefined {
  if (symbol.kind === 'structMember' && symbol.parentType) return symbol.parentType;
  return basenameFromUri(symbol.location.uri);
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

function semanticTokensForIndex(
  index: FileIndex,
  global?: SymbolLookup,
  lexicalTokens?: readonly DocumentLexicalToken[],
): SemanticTokens {
  const macroNames = new Set(index.symbols
    .filter((symbol) => symbol.kind === 'macro')
    .map((symbol) => symbol.name));
  for (const reference of index.references) {
    if (reference.context !== 'call' && reference.context !== 'pragma') continue;
    if (!macroNames.has(reference.name)
      && global?.lookup(reference.name).some((symbol) => symbol.kind === 'macro')) {
      macroNames.add(reference.name);
    }
  }

  const tokens: TokenRange[] = [];
  for (const symbol of index.symbols) {
    tokens.push({ range: symbol.location.range, tokenType: symbolTokenType(symbol.kind) });
  }
  for (const reference of index.references) {
    const tokenType = referenceTokenType(reference, macroNames);
    if (tokenType) tokens.push({ range: reference.location.range, tokenType });
  }
  if (lexicalTokens) {
    for (const token of lexicalTokens) {
      tokens.push({ range: token.range, tokenType: token.tokenType });
    }
  }

  const builder = new SemanticTokensBuilder();
  const seen = new Set<string>();
  const accepted: TokenRange[] = [];
  for (const token of tokens.sort(compareTokens)) {
    if (token.range.start.line !== token.range.end.line) continue;
    const key = tokenKey(token);
    if (seen.has(key)) continue;
    if (accepted.some((existing) => rangesOverlap(existing.range, token.range))) continue;
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

function tokenKey(token: TokenRange): string {
  const { range } = token;
  return [
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ].join(':');
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
