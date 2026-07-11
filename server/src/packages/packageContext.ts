import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import type { IncludeContext } from '../include';
import { containsPath } from '../workspace/pathUtils';
import { PackageResolver } from './packageResolver';

/**
 * Immutable package-resolution context published with one indexed revision:
 * owns the PackageResolver, derives IncludeContext, and answers package
 * membership without exposing resolution state to request handlers.
 */
export class PackageContext {
  private readonly context: IncludeContext;

  private constructor(
    context: IncludeContext,
    private readonly resolver: PackageResolver | undefined,
  ) {
    this.context = Object.freeze({
      unityProjectRoot: context.unityProjectRoot,
      includeDirectories: Object.freeze([...context.includeDirectories]),
      ...(context.packagePhysicalPaths
        ? { packagePhysicalPaths: new Map(context.packagePhysicalPaths) }
        : {}),
    });
  }

  get includeCtx(): IncludeContext {
    return Object.freeze({
      unityProjectRoot: this.context.unityProjectRoot,
      includeDirectories: Object.freeze([...this.context.includeDirectories]),
      ...(this.context.packagePhysicalPaths
        ? { packagePhysicalPaths: new Map(this.context.packagePhysicalPaths) }
        : {}),
    });
  }

  /** Standalone mode: no Unity root -> no resolver; includeCtx falls back to settings only. */
  static standalone(settings: ExtensionSettings): PackageContext {
    return new PackageContext(
      { unityProjectRoot: undefined, includeDirectories: settings.includeDirectories },
      undefined,
    );
  }

  /** Unity mode: load the lockfile resolver and derive includeCtx from it + settings. */
  static async load(unityRoot: string, settings: ExtensionSettings): Promise<PackageContext> {
    const resolver = new PackageResolver(unityRoot);
    await resolver.load();
    return new PackageContext(
      {
        unityProjectRoot: unityRoot,
        includeDirectories: settings.includeDirectories,
        packagePhysicalPaths: resolver.asIncludeContextMap(),
      },
      resolver,
    );
  }

  /** True iff a resolver was loaded (i.e. not standalone). */
  hasResolver(): boolean {
    return this.resolver !== undefined;
  }

  /** Physical roots of resolved packages. Empty when standalone. */
  packageRoots(): string[] {
    return this.resolver?.allPaths().map(({ path }) => path) ?? [];
  }

  /** Is the URI under a resolved package physical root? */
  isInPackages(uri: string): boolean {
    if (!this.resolver) return false;

    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return false;
    }

    return this.packageRoots().some((root) => containsPath(root, filePath));
  }

  /**
   * Admit cached files only when they still belong to the current index boundary.
   * Files outside the Unity root can only re-enter through a currently resolved
   * external package; stale package records must not become user files.
   */
  canRestoreCachedFile(uri: string): boolean {
    if (!this.resolver) return true;

    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      return false;
    }

    if (this.packageRoots().some((root) => containsPath(root, filePath))) return true;
    const unityRoot = this.context.unityProjectRoot;
    if (!unityRoot || !containsPath(unityRoot, filePath)) return false;
    return ![
      join(unityRoot, 'Packages'),
      join(unityRoot, 'Library', 'PackageCache'),
    ].some((root) => containsPath(root, filePath));
  }
}
