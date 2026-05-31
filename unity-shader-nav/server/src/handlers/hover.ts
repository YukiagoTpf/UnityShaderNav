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
  cursorTargetAt,
  resolveDefinitionSymbols,
  resolveMemberSymbols,
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

      let idx = workspace.index.store.get(params.textDocument.uri);
      if (!idx && typeof workspace.index?.reindex === 'function') {
        await workspace.index.reindex(doc.uri, fullText);
        idx = workspace.index.store.get(params.textDocument.uri);
      }
      if (!idx) return null;

      if (!isGenericDefinitionContext(fullText, params.position, doc.languageId, params.textDocument.uri)) {
        return null;
      }

      // Probe cheap token state BEFORE collecting visible URIs: hovering over
      // whitespace would otherwise pay the include-visibility walk for nothing.
      // detectIncludes:false because hover never navigates includes and the gate
      // already excludes include-path positions (they are lexically strings).
      const target = cursorTargetAt(fullText, params.position, { detectIncludes: false });
      if (target.kind === 'none') return null;

      const visibleUriKeys = await collectVisibleUriKeys(
        workspace.index.store,
        workspace.packages.includeCtx,
        params.textDocument.uri,
      );
      const resolutionOptions = { visibleUriKeys };

      if (target.kind === 'member') {
        const symbols = resolveMemberSymbols(
          idx,
          workspace.index.global,
          target.receiver.text,
          target.member.text,
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
          return { contents, range: target.member.range };
        }
        // Fall through to plain word resolution (parity with definition.ts).
      }

      // For a member-access miss, resolve the member token as a plain word
      // (parity with today's fallthrough); for a symbol, use its word directly.
      // 'include' cannot occur with detectIncludes:false; treat it as null.
      if (target.kind !== 'member' && target.kind !== 'symbol') return null;
      const fallbackWord = target.kind === 'member' ? target.member : target.word;

      const projectSymbols = resolveDefinitionSymbols(
        idx,
        fallbackWord.text,
        params.position,
        workspace.index.global,
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
        return { contents, range: fallbackWord.range };
      }

      const builtins = BUILTIN_ENTRIES.filter((entry) => entry.name === fallbackWord.text);
      if (builtins.length > 0) {
        const inputs: HoverInput[] = builtins.map((entry) => ({
          source: 'builtin',
          entry,
        }));
        const contents = formatHoverCandidates(inputs);
        if (contents.value.length === 0) return null;
        return { contents, range: fallbackWord.range };
      }

      return null;
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
