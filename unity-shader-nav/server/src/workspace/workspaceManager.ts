import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { detectUnityRoot } from './detectUnityRoot';
import { Workspace } from './workspace';

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

type SettingsResolver = (scopeUri: string) => ExtensionSettings | Promise<ExtensionSettings>;

export class WorkspaceManager {
  private readonly byFolder = new Map<string, Workspace>();
  private settings: ExtensionSettings | undefined;
  private connection: Connection | undefined;
  private globalStorageDir: string | undefined;
  private settingsResolver: SettingsResolver | undefined;

  configure(settings: ExtensionSettings, connection: Connection, globalStorageDir?: string): void {
    this.settings = settings;
    this.connection = connection;
    if (globalStorageDir !== undefined) this.globalStorageDir = globalStorageDir;
  }

  configureSettingsResolver(settingsResolver: SettingsResolver): void {
    this.settingsResolver = settingsResolver;
  }

  list(): Workspace[] {
    return [...this.byFolder.values()];
  }

  async persistAll(): Promise<void> {
    await Promise.all(this.list().map((workspace) => workspace.persist()));
  }

  mode(): 'standalone' | 'ready' {
    return this.list().some((workspace) => !workspace.isStandalone()) ? 'ready' : 'standalone';
  }

  private sendModeNotification(): void {
    if (typeof this.connection?.sendNotification === 'function') {
      this.connection.sendNotification('unityShaderNav/mode', { mode: this.mode() });
    }
  }

  workspaceFor(fileUri: string): Workspace | undefined {
    try {
      const filePath = fileURLToPath(fileUri);
      let best: { workspace: Workspace; length: number } | undefined;

      for (const workspace of this.byFolder.values()) {
        const folderPath = fileURLToPath(workspace.folderUri);
        if (!containsPath(folderPath, filePath)) continue;
        if (!best || folderPath.length > best.length) {
          best = { workspace, length: folderPath.length };
        }
      }

      return best?.workspace;
    } catch {
      return undefined;
    }
  }

  async addFolder(
    folderUri: string,
    settings: ExtensionSettings,
    connection: Connection,
    globalStorageDir?: string,
  ): Promise<void> {
    if (this.byFolder.has(folderUri)) return;
    const currentConnection = this.connection ?? connection;
    const currentGlobalStorageDir = globalStorageDir ?? this.globalStorageDir;
    const workspace = new Workspace(folderUri, settings);
    this.byFolder.set(folderUri, workspace);
    await workspace.bootstrap(currentConnection, currentGlobalStorageDir);
    this.sendModeNotification();
  }

  async workspaceForOrCreateFile(fileUri: string): Promise<Workspace | undefined> {
    const existing = this.workspaceFor(fileUri);
    if (existing) return existing;
    if (!this.settings || !this.connection) return undefined;

    let filePath: string;
    try {
      filePath = fileURLToPath(fileUri);
    } catch {
      return undefined;
    }

    const unityRoot = await detectUnityRoot(dirname(filePath));
    const folderPath = unityRoot ?? dirname(filePath);
    const folderUri = pathToFileURL(folderPath).href;
    const settings = this.settingsResolver
      ? await this.settingsResolver(fileUri)
      : this.settings;
    if (!settings) return undefined;

    await this.addFolder(folderUri, settings, this.connection);
    return this.workspaceFor(fileUri);
  }

  removeFolder(folderUri: string): void {
    this.byFolder.delete(folderUri);
    this.sendModeNotification();
  }
}
