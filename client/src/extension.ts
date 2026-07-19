import { commands, ExtensionContext, window } from 'vscode';
import {
  INDEX_STATUS_NOTIFICATION,
  INDEX_STATUS_REQUEST,
  type IndexStatusSnapshot,
} from '@unity-shader-nav/shared';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { createLanguageClient } from './client';
import { setupInactiveRegions } from './inactiveRegions';
import { createVariantContextPicker } from './variantContextPicker';
import { IndexStatusController, indexStatusDetails } from './indexStatus';
import { IndexStatusSession } from './indexStatusSession';
import { reportClientError, reportIndexStatus } from './output';
import { StatusBar } from './statusBar';
import {
  SHOW_INDEX_STATUS_COMMAND,
  SHOW_OUTPUT_COMMAND,
} from './statusPresentation';
import { setupFileWatchers } from './watcher';

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  const outputChannel = window.createOutputChannel('UnityShaderNav');
  const reportError = (message: string, error: unknown): void => {
    reportClientError(outputChannel, message, error);
  };
  context.subscriptions.push(outputChannel);

  const statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  client = createLanguageClient(context, outputChannel);
  const indexStatus = new IndexStatusController(statusBar);
  const indexStatusSession = new IndexStatusSession(indexStatus, {
    request: () => client!.sendRequest<IndexStatusSnapshot>(INDEX_STATUS_REQUEST),
    subscribe: (handler) => client!.onNotification(INDEX_STATUS_NOTIFICATION, handler),
  }, (error) => reportError('Failed to refresh index status', error));
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
  context.subscriptions.push(commands.registerCommand(
    SHOW_OUTPUT_COMMAND,
    () => {
      reportIndexStatus(outputChannel, indexStatusDetails(indexStatus.current()));
      outputChannel.show(true);
    },
  ));
  context.subscriptions.push(commands.registerCommand(
    SHOW_INDEX_STATUS_COMMAND,
    () => window.showQuickPick(indexStatusDetails(indexStatus.current()), {
      title: 'UnityShaderNav Index Status',
      placeHolder: 'Current workspace index lifecycle',
      matchOnDescription: true,
      matchOnDetail: true,
    }),
  ));
  await client.start();
  setupFileWatchers(client, context, reportError);
  setupInactiveRegions(client, context, reportError);
  const picker = createVariantContextPicker(client, () => {
    commands.executeCommand('unityShaderNav.refreshInactiveRegions');
  });
  context.subscriptions.push(picker);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
