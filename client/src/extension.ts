import { commands, env, ExtensionContext, Uri, window } from 'vscode';
import {
  ADAPTER_STATUS_REQUEST,
  INDEX_STATUS_NOTIFICATION,
  INDEX_STATUS_REQUEST,
  OPEN_VARIANT_COST_DOCUMENTATION_COMMAND,
  VARIANT_COST_DOCUMENTATION_URL,
  type AdapterStatus,
  type IndexStatusSnapshot,
} from '@unity-shader-nav/shared';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { createLanguageClient } from './client';
import { setupInactiveRegions } from './inactiveRegions';
import { createVariantContextPicker } from './variantContextPicker';
import { createIncludePointContextPicker } from './includePointContextPicker';
import { createVariantComparisonCommand } from './variantComparison';
import { createMaterialContextController } from './materialContextController';
import { IndexStatusController, indexStatusDetails } from './indexStatus';
import { IndexStatusSession } from './indexStatusSession';
import {
  reportAdapterStatus,
  reportClientError,
  reportIndexStatus,
} from './output';
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
  context.subscriptions.push(commands.registerCommand(
    OPEN_VARIANT_COST_DOCUMENTATION_COMMAND,
    () => env.openExternal(Uri.parse(VARIANT_COST_DOCUMENTATION_URL)),
  ));
  context.subscriptions.push(createVariantComparisonCommand(client, reportError));
  await client.start();
  try {
    const adapterStatus = await client.sendRequest<AdapterStatus>(ADAPTER_STATUS_REQUEST);
    reportAdapterStatus(outputChannel, adapterStatus);
  } catch (error) {
    reportError('Failed to query Adapter status', error);
  }
  setupFileWatchers(client, context, reportError);
  setupInactiveRegions(client, context, reportError);
  const picker = createVariantContextPicker(client, () => {
    commands.executeCommand('unityShaderNav.refreshInactiveRegions');
  });
  context.subscriptions.push(picker);
  const includePointPicker = createIncludePointContextPicker(client, () => {
    commands.executeCommand('unityShaderNav.refreshInactiveRegions');
  });
  context.subscriptions.push(includePointPicker);
  const materialContext = createMaterialContextController(client, () => {
    commands.executeCommand('unityShaderNav.refreshInactiveRegions');
  });
  context.subscriptions.push(materialContext);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
