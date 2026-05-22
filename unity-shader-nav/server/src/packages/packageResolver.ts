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
    } catch {
      return;
    }

    const lockfile = parsePackagesLock(content);
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

  resolveIncludePath(virtualPath: string): string | null {
    if (!virtualPath.startsWith('Packages/')) return null;
    const rest = virtualPath.substring('Packages/'.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.substring(0, slash);
    const subpath = slash < 0 ? '' : rest.substring(slash + 1);
    const physicalPath = this.map.get(name);

    if (!physicalPath) return null;
    return subpath ? join(physicalPath, subpath) : physicalPath;
  }

  asIncludeContextMap(): Map<string, string> {
    return new Map(this.map);
  }
}
