import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import type { WorkspaceManager } from '../workspace/workspaceManager';

interface WorkspaceFolderRef {
  uri: string;
}

interface WorkspaceFolderChange {
  added: Iterable<WorkspaceFolderRef>;
  removed: Iterable<WorkspaceFolderRef>;
}

interface CoordinatorDependencies {
  manager: Pick<WorkspaceManager, 'addFolder' | 'removeFolder'>;
  connection: Connection;
  loadSettings(scopeUri: string): ExtensionSettings | Promise<ExtensionSettings>;
  globalStorageDir?: string;
}

interface InitializationDependencies {
  manager: Pick<WorkspaceManager, 'addFolder' | 'removeFolder' | 'configure'>;
  connection: Connection;
  loadSettings(scopeUri?: string): ExtensionSettings | Promise<ExtensionSettings>;
  globalStorageDir?: string;
  onInitializationsStarted?(): void;
}

export interface WorkspaceFolderCoordinator {
  /** Reconcile the first snapshot with every event buffered since registration. */
  initialize(folders: Iterable<WorkspaceFolderRef>): Promise<void>;
}

interface NormalizedChange {
  added: string[];
  removed: string[];
}

/**
 * Register the listener synchronously, then acquire global settings and the
 * initial snapshot. The callback fires after all desired roots have started,
 * allowing startup request suspension to be released without awaiting them.
 */
export function initializeWorkspaceFolders({
  manager,
  connection,
  loadSettings,
  globalStorageDir,
  onInitializationsStarted,
}: InitializationDependencies): Promise<void> {
  const coordinator = registerWorkspaceFolderCoordinator({
    manager,
    connection,
    loadSettings: (scopeUri) => loadSettings(scopeUri),
    globalStorageDir,
  });

  return Promise.all([
    loadSettings(),
    connection.workspace.getWorkspaceFolders().then((value) => value ?? []),
  ]).then(async ([settings, folders]) => {
    manager.configure(settings, connection, globalStorageDir);
    const initializations = coordinator.initialize(folders);
    onInitializationsStarted?.();
    await initializations;
  });
}

/**
 * Register before requesting the initial folder snapshot. The coordinator owns
 * a desired folder set and a generation per add, so a slow scoped-settings read
 * cannot resurrect a folder removed by a later notification.
 */
export function registerWorkspaceFolderCoordinator({
  manager,
  connection,
  loadSettings,
  globalStorageDir,
}: CoordinatorDependencies): WorkspaceFolderCoordinator {
  const desired = new Map<string, number>();
  const buffered: NormalizedChange[] = [];
  let nextGeneration = 1;
  let initialized = false;
  let initializeCalled = false;

  const reportFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    connection.console.error(`[UnityShaderNav] workspace folder change failed: ${message}`);
  };

  const setDesired = (uri: string, present: boolean): number | undefined => {
    if (present) {
      const existing = desired.get(uri);
      if (existing !== undefined) return undefined;
      const generation = nextGeneration++;
      desired.set(uri, generation);
      return generation;
    }

    if (!desired.has(uri)) return undefined;
    desired.delete(uri);
    nextGeneration++;
    return 0;
  };

  const scheduleAdd = async (uri: string, generation: number): Promise<void> => {
    const settings = await loadSettings(uri);
    if (desired.get(uri) !== generation) return;

    // addFolder registers its record synchronously before returning the
    // terminal promise. No event can interleave between this generation check
    // and that registration.
    const adding = manager.addFolder(uri, settings, connection, globalStorageDir);
    if (desired.get(uri) !== generation) {
      await manager.removeFolder(uri);
      return;
    }
    await adding;
  };

  const applyDesiredChange = (change: NormalizedChange): {
    additions: Array<{ uri: string; generation: number }>;
    removals: string[];
  } => {
    const removals: string[] = [];
    const additions: Array<{ uri: string; generation: number }> = [];

    for (const uri of change.removed) {
      if (setDesired(uri, false) !== undefined) removals.push(uri);
    }
    for (const uri of change.added) {
      const generation = setDesired(uri, true);
      if (generation !== undefined) additions.push({ uri, generation });
    }
    return { additions, removals };
  };

  const applyLiveChange = (change: NormalizedChange): Promise<void> => {
    const { additions, removals } = applyDesiredChange(change);
    return (async () => {
      // Within one LSP event, removal is the first phase and independent
      // additions start together after it.
      await Promise.all(removals.map((uri) => manager.removeFolder(uri)));
      await Promise.all(additions.map(({ uri, generation }) => scheduleAdd(uri, generation)));
    })();
  };

  connection.workspace.onDidChangeWorkspaceFolders((event: WorkspaceFolderChange) => {
    const change = normalizeChange(event);
    if (!initialized) {
      buffered.push(change);
      return;
    }
    void applyLiveChange(change).catch(reportFailure);
  });

  return {
    initialize(folders) {
      if (initializeCalled) {
        return Promise.reject(new Error('Workspace folder coordinator was initialized twice'));
      }
      initializeCalled = true;

      for (const { uri } of folders) setDesired(uri, true);
      for (const change of buffered) applyDesiredChange(change);
      buffered.length = 0;
      initialized = true;

      const initializations = Array.from(desired, ([uri, generation]) => (
        scheduleAdd(uri, generation).catch(reportFailure)
      ));
      return Promise.all(initializations).then(() => undefined);
    },
  };
}

function normalizeChange(event: WorkspaceFolderChange): NormalizedChange {
  return {
    added: Array.from(event.added, ({ uri }) => uri),
    removed: Array.from(event.removed, ({ uri }) => uri),
  };
}
