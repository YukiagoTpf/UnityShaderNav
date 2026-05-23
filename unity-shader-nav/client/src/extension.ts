import { ExtensionContext } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { createLanguageClient } from './client';
import { StatusBar } from './statusBar';
import { setupFileWatchers } from './watcher';

let client: LanguageClient | undefined;
let statusBar: StatusBar | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  statusBar = new StatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  client = createLanguageClient(context);
  client.onNotification('unityShaderNav/mode', ({ mode }: { mode: 'standalone' | 'ready' }) => {
    statusBar?.set(mode);
  });
  await client.start();
  setupFileWatchers(client, context);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
