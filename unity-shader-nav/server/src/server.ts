import { getConnection, createInitializeResult } from './connection';
import { registerDefinitionHandler } from './handlers/definition';
import { registerDocuments } from './handlers/documents';
import { IndexStore } from './index';

const connection = getConnection();
const store = new IndexStore();

connection.onInitialize(() => createInitializeResult());

connection.onInitialized(() => {
  connection.console.log('[UnityShaderNav] server initialized');
});

const documents = registerDocuments(connection, store);
registerDefinitionHandler(connection, documents, store);

connection.listen();
