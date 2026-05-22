import { ExtensionContext } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { createLanguageClient } from './client';
import { StatusBar } from './statusBar';

let client: LanguageClient | undefined;
let statusBar: StatusBar | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  statusBar = new StatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  client = createLanguageClient(context);
  await client.start();
  statusBar.set('ready');
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
