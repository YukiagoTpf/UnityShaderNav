import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  type Connection,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { SERVER_NAME } from '@unity-shader-nav/shared';

let _connection: Connection | undefined;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = createConnection(ProposedFeatures.all);
  }
  return _connection;
}

export function createInitializeResult(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
    },
    serverInfo: {
      name: SERVER_NAME,
      version: '0.0.1',
    },
  };
}
