import type {
  Connection,
  SignatureHelp,
  SignatureHelpParams,
  TextDocuments,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { collectVisibleUriKeys } from '../index';
import type { RequestSuspender } from '../lifecycle/requestSuspender';
import type { WorkspaceManager } from '../workspace';
import {
  callContextAt,
  collectBuiltinFunctionSuggestions,
  collectVisibleProjectFunctionSuggestions,
  suggestionContextAt,
  toSignatureInformation,
} from '../suggestions';

export function registerSignatureHelpHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  suspender?: Pick<RequestSuspender, 'run'>,
): void {
  connection.onSignatureHelp(async (params: SignatureHelpParams): Promise<SignatureHelp | null> => {
    const resolveRequest = async (): Promise<SignatureHelp | null> => {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return null;

      const workspace = await manager.workspaceForOrCreateFile(params.textDocument.uri);
      if (!workspace) return null;

      const fullText = doc.getText();
      const context = suggestionContextAt(fullText, params.position, doc.languageId, params.textDocument.uri);
      if (context.kind === 'comment' || context.kind === 'string' || context.kind === 'shaderLabCode') {
        return null;
      }

      const call = callContextAt(fullText, params.position);
      if (!call) return null;

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
      const projectSuggestions = collectVisibleProjectFunctionSuggestions({
        index,
        store: workspace.store,
        visibleUriKeys,
        position: params.position,
        name: call.calleeName,
      });
      const builtinSuggestions = projectSuggestions.some((suggestion) => suggestion.name === call.calleeName)
        ? []
        : collectBuiltinFunctionSuggestions(call.calleeName, context);

      const signatures = [...projectSuggestions, ...builtinSuggestions]
        .map(toSignatureInformation)
        .filter((signature): signature is NonNullable<typeof signature> => signature !== null);

      if (signatures.length === 0) return null;
      const maxParameterIndex = Math.max(0, (signatures[0]?.parameters?.length ?? 0) - 1);

      return {
        signatures,
        activeSignature: 0,
        activeParameter: Math.min(call.activeParameter, maxParameterIndex),
      };
    };

    return suspender ? suspender.run(resolveRequest) : resolveRequest();
  });
}
