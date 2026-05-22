import * as path from 'node:path';
import { ExtensionContext } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

export function createLanguageClient(context: ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(
    path.join('..', 'server', 'out', 'server.js'),
  );

  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'shaderlab' },
      { scheme: 'file', language: 'hlsl' },
    ],
    synchronize: {},
  };

  return new LanguageClient(
    'unityShaderNav',
    'UnityShaderNav',
    serverOptions,
    clientOptions,
  );
}
