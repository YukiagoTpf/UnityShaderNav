import { isAbsolute, join, resolve } from 'node:path';

export interface LockfileEntry {
  version: string;
  source?: 'embedded' | 'builtin' | 'registry' | 'git' | 'local' | string;
  hash?: string;
}

export interface Lockfile {
  [pkgName: string]: LockfileEntry;
}

export function parsePackagesLock(content: string): Lockfile {
  const obj = JSON.parse(content);
  const deps = obj?.dependencies ?? {};
  const out: Lockfile = {};

  for (const [name, raw] of Object.entries(deps as Record<string, Partial<LockfileEntry>>)) {
    out[name] = {
      version: String(raw.version ?? ''),
      source: raw.source,
      hash: raw.hash,
    };
  }

  return out;
}

export function resolvePackagePhysicalPath(
  name: string,
  entry: LockfileEntry,
  projectRoot: string,
): string | null {
  const source = entry.source ?? '';

  if (source === 'embedded') {
    if (!entry.version.startsWith('file:')) return null;
    const dir = entry.version.slice('file:'.length);
    return join(projectRoot, 'Packages', dir);
  }

  if (source === 'local') {
    if (!entry.version.startsWith('file:')) return null;
    const raw = entry.version.slice('file:'.length);
    return isAbsolute(raw) ? raw : resolve(join(projectRoot, 'Packages'), raw);
  }

  if (source === 'registry') {
    const cacheKey = entry.hash || entry.version;
    if (!cacheKey) return null;
    return join(projectRoot, 'Library', 'PackageCache', `${name}@${cacheKey}`);
  }

  if (source === 'builtin') {
    if (!entry.version) return null;
    return join(projectRoot, 'Library', 'PackageCache', `${name}@${entry.version}`);
  }

  if (source === 'git') {
    if (!entry.hash) return null;
    // Unity 2022.3 stores all git packages — including `?path=` subpath
    // packages — under `Library/PackageCache/<name>@<hash[:10]>`. For `?path=`
    // entries Unity extracts only the requested subdirectory into that cache
    // folder, so the resolved path still points at the package root. Verified
    // empirically against Unity 2022.3.53f1c1 (issue #25).
    const dirHash = entry.hash.slice(0, 10);
    return join(projectRoot, 'Library', 'PackageCache', `${name}@${dirHash}`);
  }

  return null;
}
