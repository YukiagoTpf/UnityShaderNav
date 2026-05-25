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

export const SEMANTIC_TOKEN_TYPES = [
  'type',
  'variable',
  'parameter',
  'property',
  'function',
  'macro',
] as const;

const TOKEN_TYPE_INDEX = new Map<string, number>(
  SEMANTIC_TOKEN_TYPES.map((tokenType, index) => [tokenType, index]),
);

type SemanticTokenType = typeof SEMANTIC_TOKEN_TYPES[number];

interface TokenRange {
  range: Range;
  tokenType: SemanticTokenType;
}

const TOKEN_PRIORITY: Record<SemanticTokenType, number> = {
  macro: 0,
  type: 1,
  property: 2,
  function: 3,
  parameter: 4,
  variable: 5,
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

function semanticTokensForIndex(index: FileIndex): SemanticTokens {
  const macroNames = new Set(
    index.symbols
      .filter((symbol) => symbol.kind === 'macro')
      .map((symbol) => symbol.name),
  );
  const seen = new Set<string>();
  const tokens: TokenRange[] = [];
  for (const symbol of index.symbols) tokens.push(symbolToken(symbol));
  for (const reference of index.references) {
    const token = referenceToken(reference, macroNames);
    if (token) tokens.push(token);
  }

  const builder = new SemanticTokensBuilder();
  for (const token of tokens.sort(compareTokens)) {
    if (token.range.start.line !== token.range.end.line) continue;
    const key = tokenKey(token);
    if (seen.has(key)) continue;
    seen.add(key);

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

      let index = workspace.store.get(params.textDocument.uri);
      if (!index && typeof workspace.reindex === 'function') {
        const document = documents.get(params.textDocument.uri);
        if (document) {
          await workspace.reindex(document.uri, document.getText());
          index = workspace.store.get(params.textDocument.uri);
        }
      }
      if (!index) return { data: [] };

      return semanticTokensForIndex(index);
    };

    if (!suspender) return resolveRequest();
    return await suspender.run(resolveRequest) ?? { data: [] };
  });
}
