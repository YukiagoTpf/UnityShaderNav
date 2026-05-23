import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { detectUnityRoot } from './detectUnityRoot';
import { containsPath } from './pathUtils';
import { Workspace } from './workspace';

type SettingsResolver = (scopeUri: string) => ExtensionSettings | Promise<ExtensionSettings>;

interface WorkspaceRecord {
  workspace: Workspace;
  ready: Promise<void>;
}

export class WorkspaceManager {
  private readonly byFolder = new Map<string, WorkspaceRecord>();
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

  // Raw snapshot: may include workspaces whose bootstrap is still in flight.
  list(): Workspace[] {
    return [...this.byFolder.values()].map((record) => record.workspace);
  }

  // Operational paths that read or mutate workspace state should use this.
  async readyList(): Promise<Workspace[]> {
    const records = [...this.byFolder.values()];
    const settled = await Promise.allSettled(records.map((record) => record.ready));
    return records
      .filter((record, index) =>
        settled[index].status === 'fulfilled'
        && this.byFolder.get(record.workspace.folderUri) === record,
      )
      .map((record) => record.workspace);
  }

  async persistAll(): Promise<void> {
    const workspaces = await this.readyList();
    await Promise.all(workspaces.map((workspace) => workspace.persist()));
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

      for (const { workspace } of this.byFolder.values()) {
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

  private recordFor(fileUri: string): WorkspaceRecord | undefined {
    const workspace = this.workspaceFor(fileUri);
    if (!workspace) return undefined;
    return this.byFolder.get(workspace.folderUri);
  }

  private async workspaceFromReadyRecord(record: WorkspaceRecord): Promise<Workspace | undefined> {
    await record.ready;
    return this.byFolder.get(record.workspace.folderUri) === record
      ? record.workspace
      : undefined;
  }

  async readyWorkspaceFor(fileUri: string): Promise<Workspace | undefined> {
    const record = this.recordFor(fileUri);
    if (!record) return undefined;
    try {
      return await this.workspaceFromReadyRecord(record);
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
    const existing = this.byFolder.get(folderUri);
    if (existing) {
      await existing.ready;
      return;
    }

    const currentConnection = this.connection ?? connection;
    const currentGlobalStorageDir = globalStorageDir ?? this.globalStorageDir;
    const workspace = new Workspace(folderUri, settings);
    const record: WorkspaceRecord = { workspace, ready: Promise.resolve() };
    this.byFolder.set(folderUri, record);
    record.ready = Promise.resolve()
      .then(() => workspace.bootstrap(currentConnection, currentGlobalStorageDir))
      .then(() => {
        this.sendModeNotification();
      })
      .catch((error: unknown) => {
        const current = this.byFolder.get(folderUri);
        if (current === record) this.byFolder.delete(folderUri);
        throw error;
      });
    await record.ready;
  }

  async workspaceForOrCreateFile(fileUri: string): Promise<Workspace | undefined> {
    const existing = this.recordFor(fileUri);
    if (existing) {
      return this.workspaceFromReadyRecord(existing);
    }
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
    const created = this.recordFor(fileUri);
    if (!created) return undefined;
    return this.workspaceFromReadyRecord(created);
  }

  removeFolder(folderUri: string): void {
    this.byFolder.delete(folderUri);
    this.sendModeNotification();
  }
}
