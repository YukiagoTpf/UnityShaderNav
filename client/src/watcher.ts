import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

type FileChangeType = 'created' | 'changed' | 'deleted';

export function setupFileWatchers(client: LanguageClient, context: vscode.ExtensionContext): void {
  const code = vscode.workspace.createFileSystemWatcher('**/*.{shader,hlsl,cginc,hlslinc,compute}');
  const git = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  const lock = vscode.workspace.createFileSystemWatcher('**/Packages/packages-lock.json');
  const projectManifest = vscode.workspace.createFileSystemWatcher('**/Packages/manifest.json');
  const projectVersion = vscode.workspace.createFileSystemWatcher('**/ProjectSettings/ProjectVersion.txt');
  const packageManifest = vscode.workspace.createFileSystemWatcher('**/Packages/*/package.json');

  function forward(uri: vscode.Uri, type: FileChangeType): void {
    void client.sendNotification('unityShaderNav/fileChange', { uri: uri.toString(), type });
  }

  code.onDidCreate((uri) => forward(uri, 'created'));
  code.onDidChange((uri) => forward(uri, 'changed'));
  code.onDidDelete((uri) => forward(uri, 'deleted'));
  git.onDidCreate((uri) => forward(uri, 'created'));
  git.onDidChange((uri) => forward(uri, 'changed'));
  git.onDidDelete((uri) => forward(uri, 'deleted'));
  lock.onDidCreate((uri) => forward(uri, 'created'));
  lock.onDidChange((uri) => forward(uri, 'changed'));
  lock.onDidDelete((uri) => forward(uri, 'deleted'));
  projectManifest.onDidCreate((uri) => forward(uri, 'created'));
  projectManifest.onDidChange((uri) => forward(uri, 'changed'));
  projectManifest.onDidDelete((uri) => forward(uri, 'deleted'));
  projectVersion.onDidCreate((uri) => forward(uri, 'created'));
  projectVersion.onDidChange((uri) => forward(uri, 'changed'));
  projectVersion.onDidDelete((uri) => forward(uri, 'deleted'));
  packageManifest.onDidCreate((uri) => forward(uri, 'created'));
  packageManifest.onDidChange((uri) => forward(uri, 'changed'));
  packageManifest.onDidDelete((uri) => forward(uri, 'deleted'));

  context.subscriptions.push(code, git, lock, projectManifest, projectVersion, packageManifest);
}
