import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

type FileChangeType = 'created' | 'changed' | 'deleted';

export function setupFileWatchers(client: LanguageClient, context: vscode.ExtensionContext): void {
  const code = vscode.workspace.createFileSystemWatcher('**/*.{shader,hlsl,cginc,hlslinc,compute}');
  const git = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  const lock = vscode.workspace.createFileSystemWatcher('**/Packages/packages-lock.json');

  function forward(uri: vscode.Uri, type: FileChangeType): void {
    void client.sendNotification('unityShaderNav/fileChange', { uri: uri.toString(), type });
  }

  code.onDidCreate((uri) => forward(uri, 'created'));
  code.onDidChange((uri) => forward(uri, 'changed'));
  code.onDidDelete((uri) => forward(uri, 'deleted'));
  git.onDidChange((uri) => forward(uri, 'changed'));
  lock.onDidChange((uri) => forward(uri, 'changed'));

  context.subscriptions.push(code, git, lock);
}
