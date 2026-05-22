import { getConnection, createInitializeResult } from './connection';
import { loadSettings, onSettingsChanged } from './config';
import { registerDefinitionHandler } from './handlers/definition';
import { registerDocuments } from './handlers/documents';
import { IndexStore } from './index';
import { MacroPatternTable } from './macros';
import { indexFile } from './parser/hlsl';

const connection = getConnection();
const store = new IndexStore();
let table = new MacroPatternTable();

connection.onInitialize(() => createInitializeResult());

const documents = registerDocuments(connection, store, () => table);

async function reindexOpenDocuments(): Promise<void> {
  for (const doc of documents.all()) {
    store.set(doc.uri, await indexFile(doc.uri, doc.getText(), table));
  }
}

async function refreshSettings(scopeUri?: string): Promise<void> {
  const settings = await loadSettings(connection, scopeUri);
  table = new MacroPatternTable(settings.declarationMacros);
  await reindexOpenDocuments();
}

connection.onInitialized(async () => {
  await refreshSettings();
  connection.console.log('[UnityShaderNav] server initialized');
});

onSettingsChanged(connection, async (settings) => {
  table = new MacroPatternTable(settings.declarationMacros);
  await reindexOpenDocuments();
});

registerDefinitionHandler(connection, documents, store, refreshSettings);

connection.listen();
