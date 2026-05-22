import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

const HLSL_EXTS = new Set(['.shader', '.hlsl', '.cginc', '.hlslinc', '.compute']);

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

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
      if (isExcluded(relativePath, excludePatterns)) continue;

      if (entry.isDirectory()) {
        await recur(absolutePath);
      } else if (HLSL_EXTS.has(extensionOf(entry.name))) {
        out.push(absolutePath);
      }
    }
  }

  await recur(root);
  return out;
}
