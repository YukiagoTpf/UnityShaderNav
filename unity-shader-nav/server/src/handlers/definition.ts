import type {
  Connection,
  DefinitionParams,
  Location,
  LocationLink,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pathToFileURL } from 'node:url';
import { resolveInclude } from '../include';
import { collectVisibleUriKeys, memberAccessAt, resolveDefinition, resolveMember, wordAt } from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { scanIncludes } from '../parser/include/lineScanner';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import type { WorkspaceManager } from '../workspace';

export function registerDefinitionHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onDefinition(async (params: DefinitionParams): Promise<LocationLink[] | Location[] | null> => {
    const resolveRequest = async (): Promise<LocationLink[] | Location[] | null> => {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      const fullText = doc.getText();
      const include = scanIncludes(fullText).find((candidate) =>
        candidate.line === params.position.line
        && params.position.character >= candidate.pathRange.start.character
        && params.position.character <= candidate.pathRange.end.character,
      );
      if (include) {
        const start = include.pathRange.start.character;
        const end = include.pathRange.end.character;
        const resolved = await resolveInclude(
          include.path,
          params.textDocument.uri,
          workspace.includeCtx,
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

      let idx = workspace.store.get(params.textDocument.uri);
      if (!idx && typeof workspace.reindex === 'function') {
        await workspace.reindex(doc.uri, fullText);
        idx = workspace.store.get(params.textDocument.uri);
      }
      if (!idx) return null;

      if (!isGenericDefinitionContext(fullText, params.position, doc.languageId, params.textDocument.uri)) {
        return null;
      }

      const visibleUriKeys = await collectVisibleUriKeys(
        workspace.store,
        workspace.includeCtx,
        params.textDocument.uri,
      );
      const resolutionOptions = { visibleUriKeys };

      const memberAccess = memberAccessAt(fullText, params.position);
      if (memberAccess?.receiver) {
        const links = resolveMember(
          idx,
          workspace.global,
          memberAccess.receiver.text,
          memberAccess.member.text,
          params.position,
          resolutionOptions,
        );
        if (links.length > 0) {
          return links.map((link) => ({
            targetUri: link.targetUri,
            targetRange: link.targetRange,
            targetSelectionRange: link.targetSelectionRange,
            originSelectionRange: memberAccess.member.range,
          }));
        }
      }

      const word = wordAt(fullText, params.position);
      if (!word) return null;

      const links = resolveDefinition(
        idx,
        word.text,
        params.position,
        workspace.global,
        resolutionOptions,
      );
      if (links.length === 0) return null;

      return links.map((link) => ({
        targetUri: link.targetUri,
        targetRange: link.targetRange,
        targetSelectionRange: link.targetSelectionRange,
        originSelectionRange: word.range,
      }));
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
