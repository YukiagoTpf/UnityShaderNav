import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnection, createInitializeResult } from './connection';
import { loadSettings, onSettingsChanged } from './config';
import { registerDefinitionHandler } from './handlers/definition';
import { buildContext, type IncludeContext } from './include';
import { registerDocuments } from './handlers/documents';
import { IndexStore } from './index';
import { MacroPatternTable } from './macros';
import { indexFile } from './parser/hlsl';
import { detectUnityRoot } from './workspace/detectUnityRoot';

const connection = getConnection();
const store = new IndexStore();
let table = new MacroPatternTable();
let includeContext: IncludeContext = { unityProjectRoot: undefined, includeDirectories: [] };

connection.onInitialize(() => createInitializeResult());

const documents = registerDocuments(connection, store, () => table);

async function reindexOpenDocuments(): Promise<void> {
  for (const doc of documents.all()) {
    store.set(doc.uri, await indexFile(doc.uri, doc.getText(), table));
  }
}

async function detectWorkspaceUnityRoot(scopeUri?: string): Promise<string | undefined> {
  if (scopeUri) {
    try {
      return await detectUnityRoot(dirname(fileURLToPath(scopeUri))) ?? undefined;
    } catch {
      // fall through to workspace folders
    }
  }

  try {
    const folders = await connection.workspace.getWorkspaceFolders() ?? [];
    const firstFolder = folders[0];
    if (!firstFolder) return undefined;
    return await detectUnityRoot(fileURLToPath(firstFolder.uri)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function refreshSettings(scopeUri?: string): Promise<void> {
  const settings = await loadSettings(connection, scopeUri);
  table = new MacroPatternTable(settings.declarationMacros);
  includeContext = buildContext(settings, await detectWorkspaceUnityRoot(scopeUri));
  await reindexOpenDocuments();
}

connection.onInitialized(async () => {
  await refreshSettings();
  connection.console.log('[UnityShaderNav] server initialized');
});

onSettingsChanged(connection, async (settings) => {
  table = new MacroPatternTable(settings.declarationMacros);
  includeContext = buildContext(settings, await detectWorkspaceUnityRoot());
  await reindexOpenDocuments();
});

registerDefinitionHandler(connection, documents, store, refreshSettings, () => includeContext);

connection.listen();
