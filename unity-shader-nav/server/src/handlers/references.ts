import type {
  Connection,
  Location,
  ReferenceParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { wordAt } from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';

export function registerReferencesHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
    const resolveRequest = async (): Promise<Location[] | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      const word = wordAt(document.getText(), params.position);
      if (!word) return null;

      const includePackages = workspace.settings.findReferences.includePackages;
      const symbolsAsReferences = params.context.includeDeclaration
        ? workspace.global
          .lookup(word.text)
          .filter((symbol) => includePackages || !workspace.isInPackages(symbol.location.uri))
          .map((symbol) => ({
            uri: symbol.location.uri,
            range: symbol.location.range,
          }))
        : [];

      const references = workspace.globalRefs
        .lookup(word.text)
        .filter((reference) => includePackages || !workspace.isInPackages(reference.location.uri))
        .map((reference) => ({
          uri: reference.location.uri,
          range: reference.location.range,
        }));

      return [...symbolsAsReferences, ...references];
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
