import type {
  Connection,
  DefinitionParams,
  Location,
  LocationLink,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import { resolveInclude, type IncludeContext } from '../include';
import { IndexStore, resolveDefinition, wordAt } from '../index';
import { scanIncludes } from '../parser/include/lineScanner';

export function registerDefinitionHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  store: IndexStore,
  beforeResolve?: (uri: string) => Promise<void>,
  getIncludeContext?: () => IncludeContext,
): void {
  connection.onDefinition(async (params: DefinitionParams): Promise<LocationLink[] | Location[] | null> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    await beforeResolve?.(params.textDocument.uri);

    const lineText = doc.getText().split(/\r?\n/)[params.position.line] ?? '';
    const include = scanIncludes(lineText)[0];
    if (include && getIncludeContext) {
      const start = include.pathRange.start.character;
      const end = include.pathRange.end.character;
      if (params.position.character >= start && params.position.character <= end) {
        const resolved = await resolveInclude(
          include.path,
          params.textDocument.uri,
          getIncludeContext(),
        );
        if (!resolved) return null;
        if (resolved.caseInsensitive) {
          connection.console.warn(
            `[UnityShaderNav] case-insensitive include match: "${include.path}" -> ${resolved.absolutePath}`,
          );
        }
        const targetUri = pathToFileURL(resolved.absolutePath).href;
        const targetRange = {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        };
        return [{
          targetUri,
          targetRange,
          targetSelectionRange: targetRange,
          originSelectionRange: {
            start: { line: params.position.line, character: start },
            end: { line: params.position.line, character: end },
          },
        }];
      }
    }

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
