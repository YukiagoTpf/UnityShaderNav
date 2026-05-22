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
    latestVersions.set(doc.uri, doc.version);
    const workspace = manager.workspaceFor(doc.uri);
    if (!workspace) return;
    await workspace.reindex(doc.uri, doc.getText(), () =>
      liveUris.has(doc.uri) && latestVersions.get(doc.uri) === doc.version,
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
    manager.workspaceFor(event.document.uri)?.drop(event.document.uri);
  });

  documents.listen(connection);
  return documents;
}
