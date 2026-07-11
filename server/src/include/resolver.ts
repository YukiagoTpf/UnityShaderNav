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

function pathSegments(path: string): { root: string; parts: string[] } {
  const root = parse(path).root;
  const rest = relative(root, path);
  return {
    root,
    parts: rest.split(/[\\/]/).filter(Boolean),
  };
}

async function existsCaseSensitive(path: string, probe: FileProbe): Promise<boolean> {
  if (!(await probe.exists(path))) return false;

  const { root, parts } = pathSegments(pathResolve(path));
  let acc = root;
  for (const part of parts) {
    let entries: readonly string[];
    try {
      entries = await probe.listDir(acc);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    acc = join(acc, part);
  }
  return true;
}

async function findIgnoreCase(path: string, probe: FileProbe): Promise<string | null> {
  const { root, parts } = pathSegments(pathResolve(path));
  let acc = root;
  for (const part of parts) {
    let entries: readonly string[];
    try {
      entries = await probe.listDir(acc);
    } catch {
      return null;
    }
    const hit = entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    acc = join(acc, hit);
  }
  return acc;
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

    const candidate = subpath ? join(packageRoot, subpath) : packageRoot;
    if (await existsCaseSensitive(candidate, probe)) {
      return {
        absolutePath: candidate,
        via: 'package',
        caseInsensitive: false,
      };
    }

    const caseInsensitive = await findIgnoreCase(candidate, probe);
    if (caseInsensitive) {
      return {
        absolutePath: caseInsensitive,
        via: 'package',
        caseInsensitive: true,
      };
    }

    return null;
  }

  const candidates: Array<{ path: string; via: ResolvedInclude['via'] }> = [];
  if (isAbsolute(includePath)) {
    candidates.push({ path: includePath, via: 'relative' });
  } else {
    candidates.push({ path: pathResolve(dirname(fromPath), includePath), via: 'relative' });
    if (ctx.unityProjectRoot) {
      candidates.push({
        path: join(ctx.unityProjectRoot, 'Assets', includePath),
        via: 'assets',
      });
    }
    for (const dir of ctx.includeDirectories) {
      candidates.push({ path: join(dir, includePath), via: 'includeDirectories' });
    }
  }

  for (const candidate of candidates) {
    if (await existsCaseSensitive(candidate.path, probe)) {
      return {
        absolutePath: candidate.path,
        via: candidate.via,
        caseInsensitive: false,
      };
    }
  }

  for (const candidate of candidates) {
    const found = await findIgnoreCase(candidate.path, probe);
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
