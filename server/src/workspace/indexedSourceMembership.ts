import { fileURLToPath } from 'node:url';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import type { PackageContext } from '../packages';
import { mapWithConcurrency } from './concurrency';
import { containsPath } from './pathUtils';
import { isIndexableFilePath, walkFiles } from './walkFiles';

const PACKAGE_SOURCE_EXCLUDES = Object.freeze([
  '**/Documentation~/**',
  '**/Samples~/**',
]);
const USER_SOURCE_BOUNDARY_EXCLUDES = Object.freeze([
  'Packages/**',
  'Library/PackageCache/**',
]);
const PACKAGE_DISCOVERY_CONCURRENCY = 8;

export interface IndexedSourceFiles {
  readonly userFiles: readonly string[];
  readonly packageFiles: readonly string[];
}

/**
 * Immutable membership policy for every source admitted by one indexed revision.
 * Discovery, cache restore, watcher events, and close fallback all consume this
 * same fact instead of rebuilding path policy at their individual call sites.
 */
export class IndexedSourceMembership {
  private readonly folderRoot: string;
  private readonly unityRoot: string | undefined;
  private readonly packageRoots: readonly string[];
  private readonly packageRootsBySpecificity: readonly string[];
  private readonly userExcludes: readonly string[];

  private constructor(
    folderUri: string,
    settings: ExtensionSettings,
    unityRoot: string | undefined,
    packages: Pick<PackageContext, 'packageRoots'>,
  ) {
    this.folderRoot = fileURLToPath(folderUri);
    this.unityRoot = unityRoot;
    this.packageRoots = Object.freeze([
      ...new Set(packages.packageRoots()),
    ].sort());
    this.packageRootsBySpecificity = Object.freeze(
      [...this.packageRoots].sort((left, right) => right.length - left.length),
    );
    this.userExcludes = Object.freeze(unityRoot
      ? [...settings.excludePatterns, ...USER_SOURCE_BOUNDARY_EXCLUDES]
      : [...settings.excludePatterns]);
    Object.freeze(this);
  }

  static create(input: {
    readonly folderUri: string;
    readonly settings: ExtensionSettings;
    readonly unityRoot: string | undefined;
    readonly packages: Pick<PackageContext, 'packageRoots'>;
  }): IndexedSourceMembership {
    return new IndexedSourceMembership(
      input.folderUri,
      input.settings,
      input.unityRoot,
      input.packages,
    );
  }

  containsUri(uri: string): boolean {
    try {
      return this.classify(fileURLToPath(uri)) !== undefined;
    } catch {
      return false;
    }
  }

  async discover(signal: AbortSignal): Promise<IndexedSourceFiles> {
    if (!this.unityRoot) {
      return Object.freeze({ userFiles: Object.freeze([]), packageFiles: Object.freeze([]) });
    }

    const [userFiles, packageGroups] = await Promise.all([
      walkFiles(this.unityRoot, [...this.userExcludes], signal),
      mapWithConcurrency(
        this.packageRoots,
        PACKAGE_DISCOVERY_CONCURRENCY,
        (root) => walkFiles(root, [...PACKAGE_SOURCE_EXCLUDES], signal),
      ),
    ]);
    const classified = new Map<string, 'user' | 'package'>();
    for (const filePath of [...userFiles, ...packageGroups.flat()]) {
      const sourceClass = this.classify(filePath);
      if (sourceClass) classified.set(filePath, sourceClass);
    }
    return Object.freeze({
      userFiles: Object.freeze([...classified]
        .filter(([, sourceClass]) => sourceClass === 'user')
        .map(([filePath]) => filePath)
        .sort()),
      packageFiles: Object.freeze([...classified]
        .filter(([, sourceClass]) => sourceClass === 'package')
        .map(([filePath]) => filePath)
        .sort()),
    });
  }

  private classify(filePath: string): 'user' | 'package' | undefined {
    const packageRoot = this.packageRootsBySpecificity
      .find((root) => containsPath(root, filePath));
    if (packageRoot) {
      return isIndexableFilePath(packageRoot, filePath, PACKAGE_SOURCE_EXCLUDES)
        ? 'package'
        : undefined;
    }
    return isIndexableFilePath(
      this.unityRoot ?? this.folderRoot,
      filePath,
      this.userExcludes,
    ) ? 'user' : undefined;
  }
}
