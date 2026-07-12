import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parsePackagesLock, resolvePackagePhysicalPath } from './lockfile';

export interface ResolvedPackage {
  readonly name: string;
  readonly path: string;
  readonly source: string | undefined;
  readonly lockVersion: string;
  readonly version: string | undefined;
  readonly official: boolean;
}

export class PackageResolver {
  private readonly map = new Map<string, ResolvedPackage>();

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
    const scopedRegistryScopes = await readScopedRegistryScopes(this.projectRoot);
    for (const [name, entry] of Object.entries(lockfile)) {
      const physicalPath = resolvePackagePhysicalPath(name, entry, this.projectRoot);
      if (physicalPath === null) {
        // eslint-disable-next-line no-console
        console.warn(
          `[PackageResolver] skipping ${name} (source=${entry.source ?? 'unknown'}): no supported path mapping`,
        );
        continue;
      }
      const manifest = entry.source === 'local'
        ? undefined
        : await readPackageManifest(physicalPath, name);
      const lockVersion = entry.source === 'registry' || entry.source === 'builtin'
        ? semanticVersion(entry.version)
        : undefined;
      this.map.set(name, Object.freeze({
        name,
        path: physicalPath,
        source: entry.source,
        lockVersion: entry.version,
        version: manifest?.version ?? lockVersion,
        official: entry.source === 'builtin'
          || (entry.source === 'registry'
            && scopedRegistryScopes !== undefined
            && name.startsWith('com.unity.')
            && !scopedRegistryScopes.some((scope) => matchesScope(name, scope))),
      }));
    }
  }

  getPath(packageName: string): string | undefined {
    return this.map.get(packageName)?.path;
  }

  getVersion(packageName: string): string | undefined {
    return this.map.get(packageName)?.version;
  }

  getPackage(packageName: string): ResolvedPackage | undefined {
    return this.map.get(packageName);
  }

  allPaths(): Array<{ name: string; path: string }> {
    return [...this.map].map(([name, entry]) => ({ name, path: entry.path }));
  }

  asIncludeContextMap(): Map<string, string> {
    return new Map([...this.map].map(([name, entry]) => [name, entry.path]));
  }
}

function matchesScope(packageName: string, scope: string): boolean {
  return packageName === scope || packageName.startsWith(`${scope}.`);
}

async function readScopedRegistryScopes(projectRoot: string): Promise<readonly string[] | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(
      join(projectRoot, 'Packages', 'manifest.json'),
      'utf8',
    ));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    if (!('scopedRegistries' in value) || value.scopedRegistries === undefined) return [];
    if (!Array.isArray(value.scopedRegistries)) return undefined;
    const scopes: string[] = [];
    for (const registry of value.scopedRegistries) {
      if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) return undefined;
      if (!('scopes' in registry) || !Array.isArray(registry.scopes)) return undefined;
      for (const scope of registry.scopes) {
        if (typeof scope !== 'string' || !scope.trim()) return undefined;
        scopes.push(scope.trim());
      }
    }
    return scopes;
  } catch {
    return undefined;
  }
}

function semanticVersion(value: string): string | undefined {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) ? value : undefined;
}

async function readPackageManifest(
  packageRoot: string,
  expectedName: string,
): Promise<{ version: string } | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || !('name' in value)
      || value.name !== expectedName
      || !('version' in value)
      || typeof value.version !== 'string'
    ) return undefined;
    const version = semanticVersion(value.version);
    if (!version) return undefined;
    return { version };
  } catch {
    return undefined;
  }
}
