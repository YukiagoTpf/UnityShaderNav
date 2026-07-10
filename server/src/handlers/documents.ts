import type { Connection } from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { openDocumentGenerationKey } from '../lifecycle/rebuild';
import type { WorkspaceManager } from '../workspace';

export function registerDocuments(
  connection: Connection,
  manager: WorkspaceManager,
): TextDocuments<TextDocument> {
  const documents = new TextDocuments(TextDocument);
  const liveUris = new Set<string>();
  const latestVersions = new Map<string, number>();
  const openGenerations = new Map<string, number>();
  let nextGeneration = 0;

  const reindex = async (doc: TextDocument): Promise<void> => {
    const uri = doc.uri;
    const version = doc.version;
    const generation = openGenerations.get(uri);
    const text = doc.getText();
    latestVersions.set(uri, version);
    const workspace = await manager.workspaceForOrCreateFile(uri);
    if (!workspace) return;
    await workspace.index.reindex(uri, text, () =>
      liveUris.has(uri)
      && latestVersions.get(uri) === version
      && openGenerations.get(uri) === generation,
    );
  };

  documents.onDidOpen((event) => {
    liveUris.add(event.document.uri);
    const generation = nextGeneration++;
    openGenerations.set(event.document.uri, generation);
    Object.assign(event.document, { [openDocumentGenerationKey]: generation });
    void reindex(event.document);
  });
  documents.onDidChangeContent((event) => {
    void reindex(event.document);
  });
  documents.onDidClose((event) => {
    liveUris.delete(event.document.uri);
    latestVersions.delete(event.document.uri);
    openGenerations.delete(event.document.uri);
    delete (event.document as { [openDocumentGenerationKey]?: number })[openDocumentGenerationKey];
    manager.workspaceFor(event.document.uri)?.index.closeDocument(event.document.uri);
  });

  documents.listen(connection);
  return documents;
}
