import { fileURLToPath } from 'node:url';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import type { IncludeContext } from '../include';
import { containsPath } from '../workspace/pathUtils';
import { PackageResolver } from './packageResolver';

/**
 * Encapsulates the package concern extracted from Workspace (#28): owns the
 * PackageResolver, derives the IncludeContext, and answers isInPackages(uri).
 * Workspace composes one and reaches it via `workspace.packages`.
 */
export class PackageContext {
  private constructor(
    readonly includeCtx: IncludeContext,
    private readonly resolver: PackageResolver | undefined,
  ) {}

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
}
