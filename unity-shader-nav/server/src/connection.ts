import {
  createConnection,
  ProposedFeatures,
  type SemanticTokensOptions,
  TextDocumentSyncKind,
  type Connection,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { SERVER_NAME } from '@unity-shader-nav/shared';
import { SEMANTIC_TOKEN_TYPES } from './handlers/semanticTokens';

let _connection: Connection | undefined;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = createConnection(ProposedFeatures.all);
  }
  return _connection;
}

export function createInitializeResult(): InitializeResult {
  const semanticTokensProvider: SemanticTokensOptions = {
    legend: {
      tokenTypes: [...SEMANTIC_TOKEN_TYPES],
      tokenModifiers: [],
    },
    full: true,
  };

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      referencesProvider: true,
      documentHighlightProvider: true,
      completionProvider: {
        triggerCharacters: ['.'],
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
      },
      semanticTokensProvider,
    },
    serverInfo: {
      name: SERVER_NAME,
      version: '0.0.1',
    },
  };
}
