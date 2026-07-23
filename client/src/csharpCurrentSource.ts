import type { ExtensionContext, TextDocument } from 'vscode';
import { Uri, workspace } from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  CSHARP_CURRENT_SOURCE_CHANGED_NOTIFICATION,
  CSHARP_CURRENT_SOURCE_REQUEST,
  type CSharpCurrentSourceChangedParams,
  type CSharpCurrentSourceParams,
  type CSharpCurrentSourceResult,
} from '@unity-shader-nav/shared';

function isCSharpDocument(document: TextDocument): boolean {
  return document.languageId === 'csharp'
    || document.uri.path.toLowerCase().endsWith('.cs');
}

function sameUri(left: Uri, right: Uri): boolean {
  if (left.toString(true) === right.toString(true)) return true;
  if (left.scheme !== 'file' || right.scheme !== 'file') return false;
  const leftPath = left.fsPath;
  const rightPath = right.fsPath;
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

async function currentSource(
  params: CSharpCurrentSourceParams,
): Promise<CSharpCurrentSourceResult | null> {
  if (!params || typeof params.uri !== 'string') return null;
  let uri: Uri;
  try {
    uri = Uri.parse(params.uri, true);
  } catch {
    return null;
  }
  if (uri.scheme !== 'file' || !uri.path.toLowerCase().endsWith('.cs')) return null;

  const open = workspace.textDocuments.find((document) => (
    isCSharpDocument(document) && sameUri(document.uri, uri)
  ));
  if (open) {
    return {
      text: open.getText(),
      availability: 'open-buffer',
    };
  }

  try {
    const bytes = await workspace.fs.readFile(uri);
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      availability: 'closed-saved',
    };
  } catch {
    return null;
  }
}

export function setupCSharpCurrentSource(
  client: LanguageClient,
  context: ExtensionContext,
  reportError: (message: string, error: unknown) => void,
): void {
  context.subscriptions.push(client.onRequest(
    CSHARP_CURRENT_SOURCE_REQUEST,
    (params: CSharpCurrentSourceParams) => currentSource(params),
  ));

  const notify = (document: TextDocument): void => {
    if (!isCSharpDocument(document)) return;
    const params: CSharpCurrentSourceChangedParams = {
      uri: document.uri.toString(),
    };
    void client.sendNotification(
      CSHARP_CURRENT_SOURCE_CHANGED_NOTIFICATION,
      params,
    ).catch((error) => reportError(
      'Failed to report C# source revision change',
      error,
    ));
  };

  context.subscriptions.push(
    workspace.onDidOpenTextDocument(notify),
    workspace.onDidChangeTextDocument(({ document }) => notify(document)),
    workspace.onDidSaveTextDocument(notify),
    workspace.onDidCloseTextDocument(notify),
  );
}
