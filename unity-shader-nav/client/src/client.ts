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
];

function currentUnityShaderNavSettings(): object {
  const config = workspace.getConfiguration('unityShaderNav');
  return {
    projectRoot: config.get('projectRoot', ''),
    includeDirectories: config.get('includeDirectories', []),
    excludePatterns: config.get('excludePatterns', ['**/Library/**', '**/Temp/**', '**/Logs/**']),
    declarationMacros: config.get('declarationMacros', []),
    findReferences: {
      includePackages: config.get('findReferences.includePackages', false),
    },
  };
}

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
    synchronize: {
      configurationSection: SETTINGS_SECTIONS,
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
      settings: {
        unityShaderNav: currentUnityShaderNavSettings(),
      },
    }).catch((err) => console.error('[UnityShaderNav] failed to forward configuration change', err));
  }));

  return client;
}
