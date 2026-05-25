import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { mapWithConcurrency } from './concurrency';

const HLSL_EXTS = new Set(['.shader', '.hlsl', '.cginc', '.hlslinc', '.compute']);
const WALK_CONCURRENCY = 16;

function matchesGlob(relPath: string, pattern: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@DOUBLE_STAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DOUBLE_STAR@@/g, '.*');
  return new RegExp(`^${source}$`).test(relPath);
}

function isExcluded(relPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(relPath, pattern) || matchesGlob(`/${relPath}`, pattern));
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.substring(dot).toLowerCase() : '';
}

export async function walkFiles(root: string, excludePatterns: string[]): Promise<string[]> {
  const out: string[] = [];

  async function recur(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const childDirs: string[] = [];
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
      if (isExcluded(relativePath, excludePatterns)) continue;

      if (entry.isDirectory()) {
        childDirs.push(absolutePath);
      } else if (HLSL_EXTS.has(extensionOf(entry.name))) {
        out.push(absolutePath);
      }
    }

    await mapWithConcurrency(childDirs, WALK_CONCURRENCY, async (childDir) => {
      await recur(childDir);
    });
  }

  await recur(root);
  return out.sort();
}
