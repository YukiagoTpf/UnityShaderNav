import { commands, ExtensionContext } from 'vscode';
import {
  INDEX_STATUS_NOTIFICATION,
  INDEX_STATUS_REQUEST,
  type IndexStatusSnapshot,
} from '@unity-shader-nav/shared';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { createLanguageClient } from './client';
import { setupInactiveRegions } from './inactiveRegions';
import { IndexStatusController } from './indexStatus';
import { IndexStatusSession } from './indexStatusSession';
import { StatusBar } from './statusBar';
import { setupFileWatchers } from './watcher';

let client: LanguageClient | undefined;
let statusBar: StatusBar | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  statusBar = new StatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  client = createLanguageClient(context);
  const indexStatus = new IndexStatusController(statusBar);
  const indexStatusSession = new IndexStatusSession(indexStatus, {
    request: () => client!.sendRequest<IndexStatusSnapshot>(INDEX_STATUS_REQUEST),
    subscribe: (handler) => client!.onNotification(INDEX_STATUS_NOTIFICATION, handler),
  }, (error) => {
    console.error('[UnityShaderNav] failed to refresh index status', error);
  });
  indexStatusSession.subscribe();
  context.subscriptions.push(indexStatusSession);
  context.subscriptions.push(
    client.onDidChangeState(({ newState }) => {
      if (newState === State.Starting) indexStatusSession.starting();
      if (newState === State.Stopped) indexStatusSession.stopped();
      if (newState === State.Running) indexStatusSession.running();
    }),
  );
  context.subscriptions.push(commands.registerCommand(
    'unityShaderNav.getIndexStatus',
    () => indexStatusSession.request(),
  ));
  await client.start();
  setupFileWatchers(client, context);
  setupInactiveRegions(client, context);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
