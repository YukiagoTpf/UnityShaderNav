import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parsePackagesLock, resolvePackagePhysicalPath } from './lockfile';

export class PackageResolver {
  private readonly map = new Map<string, string>();

  constructor(private readonly projectRoot: string) {}

  async load(): Promise<void> {
    this.map.clear();
    const lockPath = join(this.projectRoot, 'Packages', 'packages-lock.json');
    let content: string;

    try {
      content = await fs.readFile(lockPath, 'utf8');
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
      throw new Error(
        `Unable to read Packages/packages-lock.json${code ? ` (${code})` : ''}.`,
        { cause: error },
      );
    }

    let lockfile: ReturnType<typeof parsePackagesLock>;
    try {
      lockfile = parsePackagesLock(content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Packages/packages-lock.json: ${detail}`, { cause: error });
    }
    for (const [name, entry] of Object.entries(lockfile)) {
      const physicalPath = resolvePackagePhysicalPath(name, entry, this.projectRoot);
      if (physicalPath === null) {
        // eslint-disable-next-line no-console
        console.warn(
          `[PackageResolver] skipping ${name} (source=${entry.source ?? 'unknown'}): no supported path mapping`,
        );
        continue;
      }
      this.map.set(name, physicalPath);
    }
  }

  getPath(packageName: string): string | undefined {
    return this.map.get(packageName);
  }

  allPaths(): Array<{ name: string; path: string }> {
    return [...this.map].map(([name, path]) => ({ name, path }));
  }

  asIncludeContextMap(): Map<string, string> {
    return new Map(this.map);
  }
}
