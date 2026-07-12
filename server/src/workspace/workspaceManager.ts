import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Connection, SymbolInformation } from 'vscode-languageserver/node';
import {
  INDEX_STATUS_NOTIFICATION,
  type ExtensionSettings,
  type IndexStatusSnapshot,
} from '@unity-shader-nav/shared';
import { detectUnityRoot } from './detectUnityRoot';
import { uriKey } from '../uriKey';
import { containsPath } from './pathUtils';
import { Workspace } from './workspace';
import type {
  DiagnosticWorkspaceService,
  IndexedDocumentSnapshot,
  OpenDocumentsProvider,
} from './indexedWorkspace';
import { compareWorkspaceSymbols } from './queries';
import type { IndexedRevisionCandidateConstructor } from './indexedRevisionCandidate';

const MAX_WORKSPACE_SYMBOLS = 1000;

type SettingsResolver = (scopeUri: string) => ExtensionSettings | Promise<ExtensionSettings>;

interface WorkspaceRecord {
  workspace: Workspace;
  terminal: Promise<void>;
  retired: Promise<void>;
  isRetired: boolean;
  persistent: boolean;
  retire(): void;
}

interface AddFolderOptions {
  persistent?: boolean;
}

export interface WorkspaceManagerRuntimeOptions {
  readonly createCandidateConstructor?: (
    folderUri: string,
  ) => IndexedRevisionCandidateConstructor;
}

export class WorkspaceManager implements DiagnosticWorkspaceService {
  private readonly byFolder = new Map<string, WorkspaceRecord>();
  private settings: ExtensionSettings | undefined;
  private connection: Connection | undefined;
  private globalStorageDir: string | undefined;
  private settingsResolver: SettingsResolver | undefined;
  private openDocuments: OpenDocumentsProvider | undefined;
  private diagnosticsRefresh: (() => void) | undefined;
  private readonly routingTransitions = new Map<Workspace, number>();
  private statusSequence = 0;

  constructor(private readonly runtimeOptions: WorkspaceManagerRuntimeOptions = {}) {}

  configure(settings: ExtensionSettings, connection: Connection, globalStorageDir?: string): void {
    this.settings = settings;
    this.configureRuntime(connection, globalStorageDir);
  }

  configureRuntime(connection: Connection, globalStorageDir?: string): void {
    this.connection = connection;
    if (globalStorageDir !== undefined) this.globalStorageDir = globalStorageDir;
  }

  configureSettingsResolver(settingsResolver: SettingsResolver): void {
    this.settingsResolver = settingsResolver;
  }

  configureOpenDocumentsProvider(provider: OpenDocumentsProvider): void {
    this.openDocuments = provider;
  }

  configureDiagnosticsRefresh(refresh: () => void): void {
    this.diagnosticsRefresh = refresh;
  }

  openDocumentSnapshot(uri: string): IndexedDocumentSnapshot | undefined {
    for (const document of this.openDocumentSnapshots()) {
      if (uriKey(document.uri) === uriKey(uri)) return document;
    }
    return undefined;
  }

  // Raw snapshot: may include workspaces whose bootstrap is still in flight.
  list(): Workspace[] {
    return [...this.byFolder.values()].map((record) => record.workspace);
  }

  // Operational paths that query published state should use this.
  async readyList(): Promise<Workspace[]> {
    return this.servingList();
  }

  private servingList(): Workspace[] {
    return this.list().filter(
      (workspace) => workspace.canServe() && !this.routingTransitions.has(workspace),
    );
  }

  workspaceSymbols(query: string): SymbolInformation[] {
    const tuple = this.servingList();
    const matches = tuple.flatMap((workspace) => workspace.workspaceSymbols(query));
    matches.sort(compareWorkspaceSymbols);
    return matches.length > MAX_WORKSPACE_SYMBOLS
      ? matches.slice(0, MAX_WORKSPACE_SYMBOLS)
      : matches;
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
    this.diagnosticsRefresh?.();
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
    return workspace?.canServe() && !this.routingTransitions.has(workspace)
      ? workspace
      : undefined;
  }

  async readyWorkspaceFor(fileUri: string): Promise<Workspace | undefined> {
    return this.servingWorkspaceFor(fileUri);
  }

  /** Every serving Workspace whose disk baseline contains this file. */
  readyWorkspacesFor(fileUri: string): Workspace[] {
    return [...this.byFolder.values()]
      .map(({ workspace }) => workspace)
      .filter((workspace) => workspace.canServe() && workspace.containsIndexedUri(fileUri))
      .sort((left, right) => right.folderUri.length - left.folderUri.length);
  }

  async addFolder(
    folderUri: string,
    settings: ExtensionSettings,
    connection: Connection,
    globalStorageDir?: string,
    options: AddFolderOptions = {},
  ): Promise<void> {
    const existing = this.byFolder.get(folderUri);
    if (existing) {
      if (options.persistent !== false) existing.persistent = true;
      await Promise.race([existing.terminal, existing.retired]);
      return;
    }

    const previousOwners = this.openDocumentOwners();
    const currentConnection = this.connection ?? connection;
    this.connection ??= currentConnection;
    const currentGlobalStorageDir = globalStorageDir ?? this.globalStorageDir;
    let workspace!: Workspace;
    workspace = new Workspace(folderUri, settings, {
      candidateConstructor: this.runtimeOptions.createCandidateConstructor?.(folderUri),
      onIndexStatusChanged: () => {
        if (this.byFolder.get(folderUri)?.workspace === workspace) {
          this.publishStatus();
        }
      },
      openDocuments: this.openDocuments
        ? () => [...this.openDocumentSnapshots()].filter(
          (document) => this.workspaceFor(document.uri) === workspace,
        )
        : undefined,
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
      persistent: options.persistent !== false,
      retire() {
        if (record.isRetired) return;
        record.isRetired = true;
        resolveRetired();
      },
    };
    this.byFolder.set(folderUri, record);
    this.publishStatus();
    const ownership = this.synchronizeOpenDocumentOwnership(
      this.displacedPreviousOwners(previousOwners),
    );
    record.terminal = ownership
      .then(() => {
        if (record.isRetired || this.byFolder.get(folderUri) !== record) return;
        return workspace.initialize(currentConnection, currentGlobalStorageDir);
      })
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

  async workspaceForOrCreateFile(
    fileUri: string,
    shouldCreate: () => boolean = () => true,
  ): Promise<Workspace | undefined> {
    if (!shouldCreate()) return undefined;
    const existing = this.recordFor(fileUri);
    if (existing) {
      return this.workspaceFromReadyRecord(existing);
    }
    if (!this.connection || (!this.settings && !this.settingsResolver)) return undefined;

    let filePath: string;
    try {
      filePath = fileURLToPath(fileUri);
    } catch {
      return undefined;
    }

    const unityRoot = await detectUnityRoot(dirname(filePath));
    if (!shouldCreate()) return undefined;
    const folderPath = unityRoot ?? dirname(filePath);
    const folderUri = pathToFileURL(folderPath).href;
    const settings = this.settingsResolver
      ? await this.settingsResolver(fileUri)
      : this.settings;
    if (!settings || !shouldCreate()) return undefined;

    await this.addFolder(
      folderUri,
      settings,
      this.connection,
      undefined,
      { persistent: false },
    );
    if (!shouldCreate()) {
      await this.releaseDocument(fileUri);
      return undefined;
    }
    const created = this.recordFor(fileUri);
    if (!created) return undefined;
    return this.workspaceFromReadyRecord(created);
  }

  async releaseDocument(fileUri: string): Promise<void> {
    const record = this.recordFor(fileUri);
    if (!record || record.persistent) return;
    if (this.ownsOpenDocument(record.workspace)) return;
    await this.removeFolder(record.workspace.folderUri);
  }

  async removeFolder(folderUri: string): Promise<void> {
    const record = this.byFolder.get(folderUri);
    if (!record) return;
    if (this.byFolder.get(folderUri) !== record) return;
    const previousOwners = this.openDocumentOwners();

    // Removal is a synchronous routing boundary. Cache data is derived and
    // already persisted after disk mutations; a final flush here would make a
    // remove/re-add pair non-linearizable and let the old instance win later.
    this.byFolder.delete(folderUri);
    record.retire();
    record.workspace.dispose();
    this.publishStatus();
    await this.synchronizeOpenDocumentOwnership(
      this.replacementOwners(previousOwners),
    );
  }

  private async synchronizeOpenDocumentOwnership(workspaces: readonly Workspace[]): Promise<void> {
    const uniqueWorkspaces = [...new Set(workspaces)];
    for (const workspace of uniqueWorkspaces) this.beginRoutingTransition(workspace);
    try {
      await Promise.all(uniqueWorkspaces.map(async (workspace) => {
        try {
          await workspace.synchronizeOpenDocuments();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (typeof this.connection?.console?.error === 'function') {
            this.connection.console.error(
              `[UnityShaderNav] live-document ownership sync failed for ${workspace.folderUri}: ${message}`,
            );
          }
        }
      }));

      for (const workspace of uniqueWorkspaces) {
        const record = this.byFolder.get(workspace.folderUri);
        if (
          !record
          || record.workspace !== workspace
          || record.persistent
          || this.ownsOpenDocument(workspace)
        ) continue;
        await this.removeFolder(workspace.folderUri);
      }
    } finally {
      for (const workspace of uniqueWorkspaces) this.endRoutingTransition(workspace);
    }
  }

  private beginRoutingTransition(workspace: Workspace): void {
    this.routingTransitions.set(workspace, (this.routingTransitions.get(workspace) ?? 0) + 1);
  }

  private endRoutingTransition(workspace: Workspace): void {
    const count = this.routingTransitions.get(workspace);
    if (count === undefined) return;
    if (count <= 1) this.routingTransitions.delete(workspace);
    else this.routingTransitions.set(workspace, count - 1);
  }

  private ownsOpenDocument(workspace: Workspace): boolean {
    return [...this.openDocumentSnapshots()].some(
      (document) => this.workspaceFor(document.uri) === workspace,
    );
  }

  private openDocumentOwners(): Map<string, Workspace> {
    const owners = new Map<string, Workspace>();
    for (const document of this.openDocumentSnapshots()) {
      const owner = this.workspaceFor(document.uri);
      if (owner) owners.set(uriKey(document.uri), owner);
    }
    return owners;
  }

  private displacedPreviousOwners(previousOwners: ReadonlyMap<string, Workspace>): Workspace[] {
    const displaced = new Set<Workspace>();
    for (const document of this.openDocumentSnapshots()) {
      const previous = previousOwners.get(uriKey(document.uri));
      if (previous && this.workspaceFor(document.uri) !== previous) displaced.add(previous);
    }
    return [...displaced];
  }

  private replacementOwners(previousOwners: ReadonlyMap<string, Workspace>): Workspace[] {
    const replacements = new Set<Workspace>();
    for (const document of this.openDocumentSnapshots()) {
      const replacement = this.workspaceFor(document.uri);
      if (
        replacement
        && replacement !== previousOwners.get(uriKey(document.uri))
      ) replacements.add(replacement);
    }
    return [...replacements];
  }

  private openDocumentSnapshots(): Iterable<IndexedDocumentSnapshot> {
    return this.openDocuments?.() ?? [];
  }

}
