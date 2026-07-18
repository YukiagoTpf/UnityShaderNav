import { promises as fs } from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve as pathResolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathIdentity } from '../pathIdentity';
import type { IncludeContext, ResolvedInclude } from './types';

/**
 * Narrow filesystem seam owned by include resolution. `exists` resolves false
 * for inaccessible paths; `listDir` may reject an inaccessible directory. The
 * resolver treats either outcome as an unresolved candidate.
 */
export interface FileProbe {
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<readonly string[]>;
}

const nodeFileProbe: FileProbe = {
  async exists(path) {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  },
  listDir(path) {
    return fs.readdir(path);
  },
};

/**
 * Wrap one resolver probe with a caller-owned directory-listing lifetime.
 * Fulfilled listings and rejections are both retained; callers discard the
 * wrapper to retry against a newer filesystem observation boundary.
 */
export function memoizeDirectoryListings(
  probe: FileProbe = nodeFileProbe,
): FileProbe {
  const listings = new Map<string, Promise<readonly string[]>>();
  return Object.freeze({
    exists(path: string) {
      return probe.exists(path);
    },
    listDir(path: string) {
      const key = pathIdentity(path);
      const cached = listings.get(key);
      if (cached) return cached;

      const listing = Promise.resolve()
        .then(() => probe.listDir(path))
        .then((entries) => Object.freeze([...entries]));
      listings.set(key, listing);
      return listing;
    },
  });
}

/**
 * Resolve only the path spelling contributed by `#include`. The anchor comes
 * from an already accepted document or project setting and may legitimately
 * contain an OS alias (for example, a Windows 8.3 ancestor).
 */
async function resolveAuthoredPath(
  anchor: string,
  authoredPath: string,
  probe: FileProbe,
  ignoreCase: boolean,
): Promise<string | null> {
  const resolvedAnchor = pathResolve(anchor);
  const candidate = pathResolve(resolvedAnchor, authoredPath);
  const normalizedAuthoredPath = relative(resolvedAnchor, candidate);
  if (!ignoreCase && !(await probe.exists(candidate))) return null;

  let acc = resolvedAnchor;
  for (const part of normalizedAuthoredPath.split(/[\\/]/).filter(Boolean)) {
    if (part === '.') continue;
    if (part === '..') {
      acc = dirname(acc);
      continue;
    }

    let entries: readonly string[];
    try {
      entries = await probe.listDir(acc);
    } catch {
      return null;
    }
    const hit = ignoreCase
      ? entries.find((entry) => entry.toLowerCase() === part.toLowerCase())
      : entries.find((entry) => entry === part);
    if (!hit) return null;
    acc = join(acc, hit);
  }
  if (!ignoreCase) return acc;
  return await probe.exists(acc) ? acc : null;
}

interface IncludeCandidate {
  readonly anchor: string;
  readonly authoredPath: string;
  readonly via: ResolvedInclude['via'];
}

export async function resolveInclude(
  includePath: string,
  fromFileUri: string,
  ctx: IncludeContext,
  probe: FileProbe = nodeFileProbe,
): Promise<ResolvedInclude | null> {
  let fromPath: string;
  try {
    fromPath = fileURLToPath(fromFileUri);
  } catch {
    return null;
  }

  if (includePath.startsWith('Packages/')) {
    const rest = includePath.substring('Packages/'.length);
    const slash = rest.indexOf('/');
    const packageName = slash < 0 ? rest : rest.substring(0, slash);
    const subpath = slash < 0 ? '' : rest.substring(slash + 1);
    const packageRoot = ctx.packagePhysicalPaths?.get(packageName);
    if (!packageRoot) return null;
    const authoredSubpath = subpath ? join('.', subpath) : '';

    const exact = await resolveAuthoredPath(packageRoot, authoredSubpath, probe, false);
    if (exact) {
      return {
        absolutePath: exact,
        via: 'package',
        caseInsensitive: false,
      };
    }

    const caseInsensitive = await resolveAuthoredPath(
      packageRoot,
      authoredSubpath,
      probe,
      true,
    );
    if (caseInsensitive) {
      return {
        absolutePath: caseInsensitive,
        via: 'package',
        caseInsensitive: true,
      };
    }

    return null;
  }

  const candidates: IncludeCandidate[] = [];
  if (isAbsolute(includePath)) {
    const root = parse(includePath).root;
    candidates.push({
      anchor: root,
      authoredPath: relative(root, includePath),
      via: 'relative',
    });
  } else {
    candidates.push({
      anchor: dirname(fromPath),
      authoredPath: includePath,
      via: 'relative',
    });
    if (ctx.unityProjectRoot) {
      candidates.push({
        anchor: ctx.unityProjectRoot,
        authoredPath: join('Assets', includePath),
        via: 'assets',
      });
    }
    for (const dir of ctx.includeDirectories) {
      candidates.push({
        anchor: dir,
        authoredPath: includePath,
        via: 'includeDirectories',
      });
    }
  }

  for (const candidate of candidates) {
    const exact = await resolveAuthoredPath(
      candidate.anchor,
      candidate.authoredPath,
      probe,
      false,
    );
    if (exact) {
      return {
        absolutePath: exact,
        via: candidate.via,
        caseInsensitive: false,
      };
    }
  }

  for (const candidate of candidates) {
    const found = await resolveAuthoredPath(
      candidate.anchor,
      candidate.authoredPath,
      probe,
      true,
    );
    if (found) {
      return {
        absolutePath: found,
        via: candidate.via,
        caseInsensitive: true,
      };
    }
  }

  return null;
}
