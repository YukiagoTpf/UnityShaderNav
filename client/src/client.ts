import * as path from 'node:path';
import { ExtensionContext, type OutputChannel, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { SETTING_SECTIONS } from '@unity-shader-nav/shared';
import { reportClientError } from './output';

export function createLanguageClient(
  context: ExtensionContext,
  outputChannel: OutputChannel,
): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));

  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'shaderlab' },
      { scheme: 'file', language: 'hlsl' },
      { scheme: 'file', language: 'shadergraph' },
    ],
    initializationOptions: {
      globalStorageDir: context.globalStorageUri.fsPath,
    },
    outputChannel,
    traceOutputChannel: outputChannel,
  };

  const client = new LanguageClient(
    'unityShaderNav',
    'UnityShaderNav',
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(workspace.onDidChangeConfiguration((event) => {
    if (!SETTING_SECTIONS.some((section) => event.affectsConfiguration(section))) return;

    void client.sendNotification('workspace/didChangeConfiguration', {
      settings: null,
    }).catch((error) => reportClientError(
      outputChannel,
      'Failed to forward configuration change',
      error,
    ));
  }));

  return client;
}
