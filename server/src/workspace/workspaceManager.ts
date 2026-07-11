import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import {
  INDEX_STATUS_NOTIFICATION,
  type ExtensionSettings,
  type IndexStatusSnapshot,
} from '@unity-shader-nav/shared';
import { detectUnityRoot } from './detectUnityRoot';
import { containsPath } from './pathUtils';
import { Workspace } from './workspace';

type SettingsResolver = (scopeUri: string) => ExtensionSettings | Promise<ExtensionSettings>;

interface WorkspaceRecord {
  workspace: Workspace;
  terminal: Promise<void>;
  retired: Promise<void>;
  isRetired: boolean;
  retire(): void;
}

export class WorkspaceManager {
  private readonly byFolder = new Map<string, WorkspaceRecord>();
  private settings: ExtensionSettings | undefined;
  private connection: Connection | undefined;
  private globalStorageDir: string | undefined;
  private settingsResolver: SettingsResolver | undefined;
  private statusSequence = 0;

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

  // Operational paths that query published state should use this.
  async readyList(): Promise<Workspace[]> {
    return this.list().filter((workspace) => workspace.canServe());
  }

  // Rebuild/recovery must not wait for an unrelated root still in its initial
  // bootstrap. Already-running rebuilds remain selectable so another trigger
  // is queued rather than lost.
  async rebuildableList(): Promise<Workspace[]> {
    return this.list().filter((workspace) => {
      const lifecycle = workspace.indexStatus().lifecycle;
      return lifecycle.state !== 'indexing' || lifecycle.operation !== 'initial';
    });
  }

  async persistAll(): Promise<void> {
    // A permanently blocked initial root must not prevent ready roots from
    // flushing during shutdown.
    const workspaces = await this.readyList();
    await Promise.all(workspaces.map((workspace) => workspace.persist()));
  }

  statusSnapshot(): IndexStatusSnapshot {
    return {
      statusSequence: this.statusSequence,
      workspaces: this.list()
        .map((workspace) => workspace.indexStatus())
        .sort((a, b) => a.folderUri.localeCompare(b.folderUri)),
    };
  }

  private publishStatus(): void {
    this.statusSequence++;
    const connection = this.connection;
    if (typeof connection?.sendNotification !== 'function') return;

    const reportFailure = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      if (typeof connection.console?.error === 'function') {
        connection.console.error(`[UnityShaderNav] index status notification failed: ${message}`);
      }
    };
    try {
      void Promise.resolve(
        connection.sendNotification(INDEX_STATUS_NOTIFICATION, this.statusSnapshot()),
      ).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
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
    await Promise.race([record.terminal, record.retired]);
    return this.byFolder.get(record.workspace.folderUri) === record
      && record.workspace.canServe()
      ? record.workspace
      : undefined;
  }

  /** Request-facing lookup: never waits for indexing and never creates state. */
  servingWorkspaceFor(fileUri: string): Workspace | undefined {
    const workspace = this.workspaceFor(fileUri);
    return workspace?.canServe() ? workspace : undefined;
  }

  async readyWorkspaceFor(fileUri: string): Promise<Workspace | undefined> {
    return this.servingWorkspaceFor(fileUri);
  }

  async addFolder(
    folderUri: string,
    settings: ExtensionSettings,
    connection: Connection,
    globalStorageDir?: string,
  ): Promise<void> {
    const existing = this.byFolder.get(folderUri);
    if (existing) {
      await Promise.race([existing.terminal, existing.retired]);
      return;
    }

    const currentConnection = this.connection ?? connection;
    this.connection ??= currentConnection;
    const currentGlobalStorageDir = globalStorageDir ?? this.globalStorageDir;
    const workspace = new Workspace(folderUri, settings, {
      onIndexStatusChanged: () => {
        if (this.byFolder.get(folderUri)?.workspace === workspace) {
          this.publishStatus();
        }
      },
    });
    let resolveRetired!: () => void;
    const retired = new Promise<void>((resolve) => {
      resolveRetired = resolve;
    });
    const record: WorkspaceRecord = {
      workspace,
      terminal: Promise.resolve(),
      retired,
      isRetired: false,
      retire() {
        if (record.isRetired) return;
        record.isRetired = true;
        resolveRetired();
      },
    };
    this.byFolder.set(folderUri, record);
    this.publishStatus();
    record.terminal = Promise.resolve()
      .then(() => workspace.initialize(currentConnection, currentGlobalStorageDir))
      .catch((error: unknown) => {
        if (record.isRetired || this.byFolder.get(folderUri) !== record) return;
        const message = error instanceof Error ? error.message : String(error);
        if (typeof currentConnection.console?.error === 'function') {
          currentConnection.console.error(
            `[UnityShaderNav] indexing failed for ${folderUri}: ${message}`,
          );
        }
      });
    await Promise.race([record.terminal, record.retired]);
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

  async removeFolder(folderUri: string): Promise<void> {
    const record = this.byFolder.get(folderUri);
    if (!record) return;
    if (this.byFolder.get(folderUri) !== record) return;

    // Removal is a synchronous routing boundary. Cache data is derived and
    // already persisted after disk mutations; a final flush here would make a
    // remove/re-add pair non-linearizable and let the old instance win later.
    this.byFolder.delete(folderUri);
    record.retire();
    record.workspace.dispose();
    this.publishStatus();
  }
}
