import type {
  Connection,
  SemanticTokens,
  SemanticTokensParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import { SemanticTokensBuilder } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileIndex, Range, ReferenceEntry, SymbolEntry, SymbolKind } from '@unity-shader-nav/shared';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';
import { scanShaderLabTokens } from '../parser/shaderlab/tokenScanner';

export const SEMANTIC_TOKEN_TYPES = [
  'type',
  'variable',
  'parameter',
  'property',
  'function',
  'macro',
  'keyword',
  'string',
  'number',
  'operator',
  'decorator',
  'enumMember',
] as const;

const TOKEN_TYPE_INDEX = new Map<string, number>(
  SEMANTIC_TOKEN_TYPES.map((tokenType, index) => [tokenType, index]),
);

type SemanticTokenType = typeof SEMANTIC_TOKEN_TYPES[number];

interface TokenRange {
  range: Range;
  tokenType: SemanticTokenType;
  source: 'index' | 'lexical';
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
    case 'struct':
      return 'type';
    case 'structMember':
      return 'property';
    case 'function':
      return 'function';
    case 'macro':
      return 'macro';
    case 'parameter':
      return 'parameter';
    case 'variable':
    case 'localVariable':
    case 'cbuffer':
      return 'variable';
  }
}

function referenceTokenType(
  reference: ReferenceEntry,
  macroNames: ReadonlySet<string>,
): SemanticTokenType | undefined {
  switch (reference.context) {
    case 'type':
      return 'type';
    case 'member':
      return 'property';
    case 'call':
    case 'pragma':
      if (macroNames.has(reference.name)) return 'macro';
      return 'function';
    case 'identifier':
      return 'variable';
    case 'include':
      return undefined;
  }
}

function symbolToken(symbol: SymbolEntry): TokenRange {
  return {
    range: symbol.location.range,
    tokenType: symbolTokenType(symbol.kind),
    source: 'index',
  };
}

function referenceToken(
  reference: ReferenceEntry,
  macroNames: ReadonlySet<string>,
): TokenRange | undefined {
  const tokenType = referenceTokenType(reference, macroNames);
  if (!tokenType) return undefined;
  return {
    range: reference.location.range,
    tokenType,
    source: 'index',
  };
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

function compareTokens(a: TokenRange, b: TokenRange): number {
  return a.range.start.line - b.range.start.line
    || a.range.start.character - b.range.start.character
    || a.range.end.character - b.range.end.character
    || TOKEN_PRIORITY[a.tokenType] - TOKEN_PRIORITY[b.tokenType];
}

function rangesOverlap(a: Range, b: Range): boolean {
  if (a.start.line !== b.start.line || a.end.line !== b.end.line) return false;
  return a.start.character < b.end.character && b.start.character < a.end.character;
}

function isShaderLabUri(uri: string): boolean {
  return /\.shader(?:$|[?#])/i.test(uri);
}

function isMacroSymbol(symbol: SymbolEntry): boolean {
  return symbol.kind === 'macro';
}

function semanticTokensForIndex(
  index: FileIndex,
  global?: SymbolLookup,
  text?: string,
): SemanticTokens {
  const macroNames = new Set(
    index.symbols
      .filter(isMacroSymbol)
      .map((symbol) => symbol.name),
  );
  for (const reference of index.references) {
    if (reference.context !== 'call' && reference.context !== 'pragma') continue;
    if (macroNames.has(reference.name)) continue;
    if (global?.lookup(reference.name).some(isMacroSymbol)) macroNames.add(reference.name);
  }

  const seen = new Set<string>();
  const tokens: TokenRange[] = [];
  for (const symbol of index.symbols) tokens.push(symbolToken(symbol));
  for (const reference of index.references) {
    const token = referenceToken(reference, macroNames);
    if (token) tokens.push(token);
  }
  if (text && isShaderLabUri(index.uri)) {
    for (const token of scanShaderLabTokens(text)) {
      tokens.push({
        range: token.range,
        tokenType: token.tokenType,
        source: 'lexical',
      });
    }
  }

  const builder = new SemanticTokensBuilder();
  const accepted: TokenRange[] = [];
  for (const token of tokens.sort(compareTokens)) {
    if (token.range.start.line !== token.range.end.line) continue;
    const key = tokenKey(token);
    if (seen.has(key)) continue;
    if (accepted.some((existing) => rangesOverlap(existing.range, token.range))) continue;
    seen.add(key);
    accepted.push(token);

    const tokenType = TOKEN_TYPE_INDEX.get(token.tokenType);
    if (tokenType === undefined) continue;

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

export function registerSemanticTokensHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.languages.semanticTokens.on(async (params: SemanticTokensParams): Promise<SemanticTokens> => {
    const resolveRequest = async (): Promise<SemanticTokens> => {
      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return { data: [] };

      let index = workspace.index.store.get(params.textDocument.uri);
      const document = documents.get(params.textDocument.uri);
      if (!index && typeof workspace.index?.reindex === 'function') {
        if (document) {
          await workspace.index.reindex(document.uri, document.getText());
          index = workspace.index.store.get(params.textDocument.uri);
        }
      }
      if (!index) return { data: [] };

      return semanticTokensForIndex(index, workspace.index.global, document?.getText());
    };

    if (!suspender) return resolveRequest();
    return await suspender.run(resolveRequest) ?? { data: [] };
  });
}
