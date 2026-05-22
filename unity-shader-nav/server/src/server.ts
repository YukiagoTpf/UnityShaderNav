import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getConnection, createInitializeResult } from './connection';

const connection = getConnection();
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => createInitializeResult());

connection.onInitialized(() => {
  connection.console.log('[UnityShaderNav] server initialized');
});

documents.listen(connection);
connection.listen();
