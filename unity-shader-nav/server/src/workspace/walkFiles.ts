import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

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
  const queue = [root];
  let active = 0;
  let done = false;
  const waitingWorkers: Array<() => void> = [];

  function wake(): void {
    for (const resolve of waitingWorkers.splice(0)) {
      resolve();
    }
  }

  async function waitForWork(): Promise<void> {
    if (queue.length > 0 || done) return;
    await new Promise<void>((resolve) => {
      waitingWorkers.push(resolve);
    });
  }

  async function worker(): Promise<void> {
    while (true) {
      await waitForWork();
      const dir = queue.shift();
      if (!dir) {
        if (done) return;
        continue;
      }

      active++;

      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        active--;
        if (active === 0 && queue.length === 0) {
          done = true;
          wake();
        }
        continue;
      }

      for (const entry of entries) {
        const absolutePath = join(dir, entry.name);
        const relativePath = relative(root, absolutePath).replace(/\\/g, '/');
        if (isExcluded(relativePath, excludePatterns)) continue;

        if (entry.isDirectory()) {
          queue.push(absolutePath);
          wake();
        } else if (HLSL_EXTS.has(extensionOf(entry.name))) {
          out.push(absolutePath);
        }
      }

      active--;
      if (active === 0 && queue.length === 0) {
        done = true;
        wake();
      }
    }
  }

  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, () => worker()));
  return out.sort();
}
