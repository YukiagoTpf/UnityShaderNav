import type {
  Connection,
  Hover,
  HoverParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { formatHoverCandidates, type HoverInput } from '../hover';
import {
  collectVisibleUriKeys,
  memberAccessAt,
  resolveDefinitionSymbols,
  resolveMemberSymbols,
  wordAt,
} from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import { isGenericDefinitionContext } from '../parser/lexical/context';
import { BUILTIN_ENTRIES } from '../suggestions/builtins';
import type { WorkspaceManager } from '../workspace';

export function registerHoverHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onHover(async (params: HoverParams): Promise<Hover | null> => {
    const resolveRequest = async (): Promise<Hover | null> => {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      const fullText = doc.getText();

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
        const symbols = resolveMemberSymbols(
          idx,
          workspace.global,
          memberAccess.receiver.text,
          memberAccess.member.text,
          params.position,
          resolutionOptions,
        );
        if (symbols.length > 0) {
          const inputs: HoverInput[] = symbols.map((symbol) => ({
            source: 'project',
            symbol,
            workspaceRootUri: workspace.folderUri,
          }));
          const contents = formatHoverCandidates(inputs);
          // Defensive: formatHoverCandidates only returns an empty value when
          // given zero inputs (guarded above), but keep the check so a future
          // formatter change cannot silently surface an empty hover bubble.
          if (contents.value.length === 0) return null;
          return { contents, range: memberAccess.member.range };
        }
        // Fall through to plain word resolution (parity with definition.ts).
      }

      const word = wordAt(fullText, params.position);
      if (!word) return null;

      const projectSymbols = resolveDefinitionSymbols(
        idx,
        word.text,
        params.position,
        workspace.global,
        resolutionOptions,
      );
      if (projectSymbols.length > 0) {
        const inputs: HoverInput[] = projectSymbols.map((symbol) => ({
          source: 'project',
          symbol,
          workspaceRootUri: workspace.folderUri,
        }));
        const contents = formatHoverCandidates(inputs);
        if (contents.value.length === 0) return null;
        return { contents, range: word.range };
      }

      const builtins = BUILTIN_ENTRIES.filter((entry) => entry.name === word.text);
      if (builtins.length > 0) {
        const inputs: HoverInput[] = builtins.map((entry) => ({
          source: 'builtin',
          entry,
        }));
        const contents = formatHoverCandidates(inputs);
        if (contents.value.length === 0) return null;
        return { contents, range: word.range };
      }

      return null;
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
