import type {
  CompletionItem,
  CompletionParams,
  Connection,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { collectVisibleUriKeys } from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';
import {
  collectBuiltinSuggestions,
  collectMemberSuggestions,
  collectVisibleProjectSuggestions,
  suggestionContextAt,
  toCompletionItem,
} from '../suggestions';
import type { ShaderSuggestion } from '../suggestions';

function mergeProjectAndBuiltinSuggestions(
  projectSuggestions: ShaderSuggestion[],
  builtinSuggestions: ShaderSuggestion[],
): ShaderSuggestion[] {
  const projectNames = new Set(projectSuggestions.map((suggestion) => suggestion.name));
  const seenBuiltinNames = new Set<string>();
  const visibleBuiltins: ShaderSuggestion[] = [];
  for (const suggestion of builtinSuggestions) {
    if (projectNames.has(suggestion.name) || seenBuiltinNames.has(suggestion.name)) continue;
    seenBuiltinNames.add(suggestion.name);
    visibleBuiltins.push(suggestion);
  }
  return [...projectSuggestions, ...visibleBuiltins];
}

export function registerCompletionHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[] | null> => {
    const resolveRequest = async (): Promise<CompletionItem[] | null> => {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      const fullText = doc.getText();
      const context = suggestionContextAt(fullText, params.position, doc.languageId, params.textDocument.uri);
      if (context.kind === 'comment' || context.kind === 'string') {
        return [];
      }

      let index = workspace.store.get(params.textDocument.uri);
      if (!index && typeof workspace.reindex === 'function') {
        await workspace.reindex(doc.uri, fullText);
        index = workspace.store.get(params.textDocument.uri);
      }
      if (!index) return null;

      const visibleUriKeys = await collectVisibleUriKeys(
        workspace.store,
        workspace.packages.includeCtx,
        params.textDocument.uri,
      );

      const suggestions = context.member
        ? collectMemberSuggestions(
          index,
          workspace.store,
          workspace.global,
          visibleUriKeys,
          context.member.receiver,
          context.member.memberPrefix.text,
          params.position,
        )
        : mergeProjectAndBuiltinSuggestions(
          context.kind === 'hlslCode'
            ? collectVisibleProjectSuggestions({
              index,
              store: workspace.store,
              visibleUriKeys,
              position: params.position,
            }).filter((suggestion) => suggestion.name.startsWith(context.prefix.text))
            : [],
          collectBuiltinSuggestions(context),
        );

      return suggestions.map(toCompletionItem);
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
