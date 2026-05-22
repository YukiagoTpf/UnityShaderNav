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

  const reindex = async (doc: TextDocument): Promise<void> => {
    const idx = await indexFile(doc.uri, doc.getText());
    store.set(doc.uri, idx);
    connection.console.log(
      `[index] ${doc.uri} -> ${idx.symbols.length} symbols, ${idx.references.length} refs`,
    );
  };

  documents.onDidOpen((event) => {
    void reindex(event.document);
  });
  documents.onDidChangeContent((event) => {
    void reindex(event.document);
  });
  documents.onDidClose((event) => {
    store.delete(event.document.uri);
  });

  documents.listen(connection);
  return documents;
}
