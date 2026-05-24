import type { Connection } from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { WorkspaceManager } from '../workspace';

export function registerDocuments(
  connection: Connection,
  manager: WorkspaceManager,
): TextDocuments<TextDocument> {
  const documents = new TextDocuments(TextDocument);
  const liveUris = new Set<string>();
  const latestVersions = new Map<string, number>();

  const reindex = async (doc: TextDocument): Promise<void> => {
    const uri = doc.uri;
    const version = doc.version;
    const text = doc.getText();
    latestVersions.set(uri, version);
    const workspace = await manager.workspaceForOrCreateFile(uri);
    if (!workspace) return;
    await workspace.reindex(uri, text, () =>
      liveUris.has(uri) && latestVersions.get(uri) === version,
    );
  };

  documents.onDidOpen((event) => {
    liveUris.add(event.document.uri);
    void reindex(event.document);
  });
  documents.onDidChangeContent((event) => {
    void reindex(event.document);
  });
  documents.onDidClose((event) => {
    liveUris.delete(event.document.uri);
    latestVersions.delete(event.document.uri);
    manager.workspaceFor(event.document.uri)?.closeDocument(event.document.uri);
  });

  documents.listen(connection);
  return documents;
}
