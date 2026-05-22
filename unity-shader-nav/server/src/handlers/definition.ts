import type {
  Connection,
  DefinitionParams,
  Location,
  LocationLink,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { IndexStore, resolveDefinition, wordAt } from '../index';

export function registerDefinitionHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  store: IndexStore,
  beforeResolve?: (uri: string) => Promise<void>,
): void {
  connection.onDefinition(async (params: DefinitionParams): Promise<LocationLink[] | Location[] | null> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    await beforeResolve?.(params.textDocument.uri);

    const idx = store.get(params.textDocument.uri);
    if (!idx) return null;

    const word = wordAt(doc.getText(), params.position);
    if (!word) return null;

    const links = resolveDefinition(idx, word.text, params.position);
    if (links.length === 0) return null;

    return links.map((link) => ({
      targetUri: link.targetUri,
      targetRange: link.targetRange,
      targetSelectionRange: link.targetSelectionRange,
      originSelectionRange: word.range,
    }));
  });
}
