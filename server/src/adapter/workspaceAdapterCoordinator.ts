import type { AdapterStatus } from '@unity-shader-nav/shared';
import { pathIdentity } from '../pathIdentity';
import type {
  CSharpPropertyTarget,
  CSharpPropertyUsageProvider,
  CSharpPropertyUsageResult,
} from './csharpPropertySource';
import {
  AdapterRegistry,
} from './adapterRegistry';
import type {
  MaterialContextProvider,
  TrustedMaterialContextResult,
} from './materialContextSource';
import type {
  MaterialPropertyRenamePrepareResult,
  MaterialPropertyRenameProvider,
  MaterialPropertyRenameRequest,
  MaterialShaderIdentity,
  MaterialUsageProvider,
  MaterialUsageResult,
} from './materialSource';
import type {
  ShaderGraphUsageProvider,
  ShaderGraphUsageResult,
} from './shaderGraphSource';
import {
  UnityAdapterClient,
  type UnityAdapterClientState,
} from './ipc/unityAdapterClient';
import type { AdapterRpcConnection } from './ipc/rpcConnection';

export interface AdapterWorkspaceSnapshot {
  readonly folderUri: string;
  readonly unityRoot: string | undefined;
}

export interface WorkspaceAdapterCoordinatorOptions {
  readonly createRegistry?: () => AdapterRegistry;
  readonly createClient?: (
    unityRoot: string,
    registry: AdapterRegistry,
  ) => UnityAdapterClient;
  readonly reportError?: (message: string, error: unknown) => void;
}

interface ProjectConnection {
  readonly key: string;
  readonly unityRoot: string;
  readonly registry: AdapterRegistry;
  readonly client: UnityAdapterClient;
  readonly folders: Set<string>;
  readonly subscriptions: Array<{ dispose(): void }>;
}

/**
 * Stable provider captured by one Workspace. Its delegate can be rebound after
 * indexing discovers the actual Unity project root, so two Workspace folders
 * that resolve to the same project share exactly one Editor connection.
 */
export class WorkspaceAdapterScope
implements
  MaterialUsageProvider,
  MaterialPropertyRenameProvider,
  CSharpPropertyUsageProvider,
  ShaderGraphUsageProvider,
  MaterialContextProvider {
  private readonly fallback = new AdapterRegistry();
  private delegate: AdapterRegistry = this.fallback;

  bind(registry: AdapterRegistry | undefined): void {
    this.delegate = registry ?? this.fallback;
  }

  materialsUsingShader(
    shader: MaterialShaderIdentity,
  ): Promise<MaterialUsageResult> {
    return this.delegate.materialsUsingShader(shader);
  }

  materialPropertyRenameAvailability(): {
    readonly available: boolean;
    readonly reason?: string;
  } {
    return this.delegate.materialPropertyRenameAvailability();
  }

  prepareMaterialPropertyRename(
    request: MaterialPropertyRenameRequest,
  ): Promise<MaterialPropertyRenamePrepareResult> {
    return this.delegate.prepareMaterialPropertyRename(request);
  }

  csharpPropertyUsagesFor(
    target: CSharpPropertyTarget,
  ): Promise<CSharpPropertyUsageResult> {
    return this.delegate.csharpPropertyUsagesFor(target);
  }

  shaderGraphCustomFunctions(): Promise<ShaderGraphUsageResult> {
    return this.delegate.shaderGraphCustomFunctions();
  }

  selectedMaterialContext(): Promise<TrustedMaterialContextResult> {
    return this.delegate.selectedMaterialContext();
  }
}

/**
 * Owns the production one-project/one-stream topology from ADR-0008.
 * Discovery is passive and asynchronous; no Adapter operation can delay index
 * publication or affect another project root.
 */
export class WorkspaceAdapterCoordinator {
  private readonly createRegistry: () => AdapterRegistry;
  private readonly createClient: (
    unityRoot: string,
    registry: AdapterRegistry,
  ) => UnityAdapterClient;
  private readonly reportError: (message: string, error: unknown) => void;
  private readonly scopes = new Map<string, WorkspaceAdapterScope>();
  private readonly projectByFolder = new Map<string, ProjectConnection>();
  private readonly projects = new Map<string, ProjectConnection>();
  private readonly materialContextListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(status: AdapterStatus) => void>();
  private disposed = false;

  constructor(options: WorkspaceAdapterCoordinatorOptions = {}) {
    this.createRegistry = options.createRegistry ?? (() => new AdapterRegistry());
    this.createClient = options.createClient
      ?? ((unityRoot, registry) => new UnityAdapterClient({
        unityRoot,
        registry,
      }));
    this.reportError = options.reportError ?? (() => undefined);
  }

  adapterForFolder(folderUri: string): WorkspaceAdapterScope {
    let scope = this.scopes.get(folderUri);
    if (!scope) {
      scope = new WorkspaceAdapterScope();
      this.scopes.set(folderUri, scope);
    }
    return scope;
  }

  registryForFolder(folderUri: string): AdapterRegistry | undefined {
    return this.projectByFolder.get(folderUri)?.registry;
  }

  clientForFolder(folderUri: string): UnityAdapterClient | undefined {
    return this.projectByFolder.get(folderUri)?.client;
  }

  rpcForFolder(folderUri: string): AdapterRpcConnection | undefined {
    return this.clientForFolder(folderUri)?.rpc;
  }

  stateForFolder(folderUri: string): UnityAdapterClientState | undefined {
    return this.clientForFolder(folderUri)?.state;
  }

  /**
   * Reconcile one immutable Workspace snapshot. Repeated indexing status
   * notifications are idempotent and never restart an unchanged connection.
   */
  reconcile(workspaces: readonly AdapterWorkspaceSnapshot[]): void {
    if (this.disposed) return;
    const desiredFolders = new Set(workspaces.map(({ folderUri }) => folderUri));
    const desiredProjects = new Map<string, {
      readonly unityRoot: string;
      readonly folders: string[];
    }>();

    for (const workspace of workspaces) {
      this.adapterForFolder(workspace.folderUri);
      if (!workspace.unityRoot) continue;
      const key = pathIdentity(workspace.unityRoot);
      const desired = desiredProjects.get(key);
      if (desired) desired.folders.push(workspace.folderUri);
      else {
        desiredProjects.set(key, {
          unityRoot: workspace.unityRoot,
          folders: [workspace.folderUri],
        });
      }
    }

    for (const folderUri of [...this.scopes.keys()]) {
      if (desiredFolders.has(folderUri)) continue;
      this.scopes.get(folderUri)?.bind(undefined);
      this.scopes.delete(folderUri);
      this.projectByFolder.delete(folderUri);
    }

    for (const project of this.projects.values()) project.folders.clear();
    for (const [key, desired] of desiredProjects) {
      const project = this.projects.get(key)
        ?? this.createProject(key, desired.unityRoot);
      for (const folderUri of desired.folders) {
        project.folders.add(folderUri);
        this.projectByFolder.set(folderUri, project);
        this.scopes.get(folderUri)?.bind(project.registry);
      }
    }

    for (const [key, project] of [...this.projects]) {
      if (project.folders.size > 0) continue;
      this.disposeProject(project);
      this.projects.delete(key);
    }

    for (const workspace of workspaces) {
      if (workspace.unityRoot) continue;
      this.projectByFolder.delete(workspace.folderUri);
      this.scopes.get(workspace.folderUri)?.bind(undefined);
    }
    this.publishMaterialContextChange();
    this.publishStatusChange();
  }

  status(): AdapterStatus {
    const connected = [...this.projects.values()]
      .map(({ registry }) => registry.status())
      .filter((candidate): candidate is Extract<
        AdapterStatus,
        { readonly mode: 'adapter' }
      > => candidate.mode === 'adapter');
    if (connected.length > 0) return connected[0];

    const unavailable = [...this.projects.values()]
      .map(({ registry }) => registry.status())
      .filter((candidate): candidate is Extract<
        AdapterStatus,
        { readonly mode: 'standalone' }
      > => candidate.mode === 'standalone');
    if (unavailable.some(({ reason }) => reason === 'disconnected')) {
      return { mode: 'standalone', reason: 'disconnected' };
    }
    return unavailable[0] ?? { mode: 'standalone', reason: 'no-adapter' };
  }

  onDidChangeMaterialContext(listener: () => void): { dispose(): void } {
    this.materialContextListeners.add(listener);
    return {
      dispose: () => { this.materialContextListeners.delete(listener); },
    };
  }

  onDidChangeStatus(
    listener: (status: AdapterStatus) => void,
  ): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => { this.statusListeners.delete(listener); } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const project of this.projects.values()) this.disposeProject(project);
    this.projects.clear();
    this.projectByFolder.clear();
    for (const scope of this.scopes.values()) scope.bind(undefined);
    this.scopes.clear();
    this.materialContextListeners.clear();
    this.statusListeners.clear();
  }

  private createProject(key: string, unityRoot: string): ProjectConnection {
    const registry = this.createRegistry();
    const client = this.createClient(unityRoot, registry);
    const project: ProjectConnection = {
      key,
      unityRoot,
      registry,
      client,
      folders: new Set(),
      subscriptions: [],
    };
    project.subscriptions.push(
      registry.onDidChangeMaterialContext(
        () => { this.publishMaterialContextChange(); },
      ),
      registry.onDidChangeStatus(
        () => { this.publishStatusChange(); },
      ),
      client.onDidChangeState(
        () => {
          this.publishMaterialContextChange();
          this.publishStatusChange();
        },
      ),
    );
    this.projects.set(key, project);
    void client.start().catch((error: unknown) => {
      this.reportError(
        `Adapter discovery failed for ${unityRoot}`,
        error,
      );
    });
    return project;
  }

  private disposeProject(project: ProjectConnection): void {
    project.client.stop();
    for (const subscription of project.subscriptions) subscription.dispose();
    for (const folderUri of project.folders) {
      if (this.projectByFolder.get(folderUri) === project) {
        this.projectByFolder.delete(folderUri);
      }
    }
    project.folders.clear();
  }

  private publishMaterialContextChange(): void {
    for (const listener of [...this.materialContextListeners]) listener();
  }

  private publishStatusChange(): void {
    const status = this.status();
    for (const listener of [...this.statusListeners]) listener(status);
  }
}
