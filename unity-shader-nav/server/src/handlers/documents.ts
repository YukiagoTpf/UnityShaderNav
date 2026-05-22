import type { Connection } from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { IndexStore } from '../index';
import { indexFile } from '../parser/hlsl';

export function registerDocuments(
  connection: Connection,
  store: IndexStore,
): TextDocuments<TextDocument> {
  const documents = new TextDocuments(TextDocument);
  const liveUris = new Set<string>();
  const latestVersions = new Map<string, number>();

  const reindex = async (doc: TextDocument): Promise<void> => {
    latestVersions.set(doc.uri, doc.version);
    const idx = await indexFile(doc.uri, doc.getText());
    if (!liveUris.has(doc.uri) || latestVersions.get(doc.uri) !== doc.version) return;
    store.set(doc.uri, idx);
    connection.console.log(
      `[index] ${doc.uri} -> ${idx.symbols.length} symbols, ${idx.references.length} refs`,
    );
  };

  documents.onDidOpen((event) => {
    liveUris.add(event.document.uri);
  });
  documents.onDidChangeContent((event) => {
    void reindex(event.document);
  });
  documents.onDidClose((event) => {
    liveUris.delete(event.document.uri);
    latestVersions.delete(event.document.uri);
    store.delete(event.document.uri);
  });

  documents.listen(connection);
  return documents;
}
