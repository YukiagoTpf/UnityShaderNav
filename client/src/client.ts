import * as path from 'node:path';
import { ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

const SETTINGS_SECTIONS = [
  'unityShaderNav.projectRoot',
  'unityShaderNav.includeDirectories',
  'unityShaderNav.excludePatterns',
  'unityShaderNav.declarationMacros',
  'unityShaderNav.findReferences.includePackages',
  'unityShaderNav.dimInactiveBranches.enabled',
  'unityShaderNav.dimInactiveBranches.opacity',
];

export function createLanguageClient(context: ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('out', 'server', 'server.js'));

  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'shaderlab' },
      { scheme: 'file', language: 'hlsl' },
    ],
    initializationOptions: {
      globalStorageDir: context.globalStorageUri.fsPath,
    },
  };

  const client = new LanguageClient(
    'unityShaderNav',
    'UnityShaderNav',
    serverOptions,
    clientOptions,
  );

  context.subscriptions.push(workspace.onDidChangeConfiguration((event) => {
    const changed = SETTINGS_SECTIONS.some((section) => event.affectsConfiguration(section));
    if (!changed) return;

    void client.sendNotification('workspace/didChangeConfiguration', {
      settings: null,
    }).catch((err) => console.error('[UnityShaderNav] failed to forward configuration change', err));
  }));

  return client;
}
