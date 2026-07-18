import { isAbsolute, join, resolve } from 'node:path';

export interface LockfileEntry {
  version: string;
  source?: 'embedded' | 'builtin' | 'registry' | 'git' | 'local' | string;
  hash?: string;
}

export interface Lockfile {
  [pkgName: string]: LockfileEntry;
}

export interface MalformedLockfileEntry {
  readonly name: string;
  readonly reason: string;
}

export interface PackagesLockParseResult {
  readonly entries: Lockfile;
  readonly malformedEntries: readonly MalformedLockfileEntry[];
}

export function parsePackagesLock(content: string): PackagesLockParseResult {
  const obj: unknown = JSON.parse(content);
  if (!isRecord(obj)) {
    throw new Error('expected a top-level object');
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'dependencies')) {
    throw new Error('missing dependencies object');
  }
  const deps = obj.dependencies;
  if (!isRecord(deps)) {
    throw new Error('dependencies must be an object');
  }
  const out: Lockfile = {};
  const malformedEntries: MalformedLockfileEntry[] = [];

  for (const [name, raw] of Object.entries(deps)) {
    const parsed = parseLockfileEntry(raw);
    if (typeof parsed === 'string') {
      malformedEntries.push({ name, reason: parsed });
      continue;
    }
    out[name] = parsed;
  }

  return { entries: out, malformedEntries };
}

function parseLockfileEntry(raw: unknown): LockfileEntry | string {
  if (!isRecord(raw)) return 'must be an object';
  if (typeof raw.version !== 'string') return 'must have a string version';
  if (raw.source !== undefined && typeof raw.source !== 'string') {
    return 'source must be a string';
  }
  if (raw.hash !== undefined && typeof raw.hash !== 'string') {
    return 'hash must be a string';
  }

  const entry: LockfileEntry = {
    version: raw.version,
    source: raw.source as string | undefined,
    hash: raw.hash as string | undefined,
  };
  return knownSourceValidationError(entry) ?? entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function knownSourceValidationError(entry: LockfileEntry): string | undefined {
  if (entry.source !== undefined && (
    !entry.source.trim() || entry.source !== entry.source.trim()
  )) {
    return 'must have a non-empty source without surrounding whitespace';
  }

  switch (entry.source) {
    case 'embedded':
    case 'local': {
      const target = entry.version.startsWith('file:')
        ? entry.version.slice('file:'.length)
        : '';
      return entry.version === entry.version.trim()
        && target.length > 0
        && target === target.trim()
        ? undefined
        : `with source ${entry.source} must have a non-empty file: version`;
    }
    case 'registry':
    case 'builtin':
      return entry.version.trim() && entry.version === entry.version.trim()
        ? undefined
        : `with source ${entry.source} must have a non-empty version without surrounding whitespace`;
    case 'git':
      if (!entry.version.trim() || entry.version !== entry.version.trim()) {
        return 'with source git must have a non-empty version without surrounding whitespace';
      }
      return entry.hash?.trim() && entry.hash === entry.hash.trim()
        ? undefined
        : 'with source git must have a non-empty hash without surrounding whitespace';
    default:
      return undefined;
  }
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
    // empirically against Unity 2022.3.53f1c1 lockfiles.
    const dirHash = entry.hash.slice(0, 10);
    return join(projectRoot, 'Library', 'PackageCache', `${name}@${dirHash}`);
  }

  return null;
}
