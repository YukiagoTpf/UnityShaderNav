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

export async function walkFiles(
  root: string,
  excludePatterns: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) throw abortReason(signal);
  const out: string[] = [];
  const queue = [root];
  let active = 0;
  let done = false;
  let failure: Error | undefined;
  const waitingWorkers: Array<() => void> = [];

  const onAbort = (): void => {
    failure ??= abortReason(signal!);
    queue.length = 0;
    done = true;
    wake();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

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
      } catch (error) {
        active--;
        const detail = error instanceof Error ? error.message : String(error);
        failure ??= new Error(`Unable to traverse ${dir}: ${detail}`, { cause: error });
        queue.length = 0;
        done = true;
        wake();
        return;
      }

      if (failure) {
        active--;
        return;
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

  try {
    await Promise.all(Array.from({ length: WALK_CONCURRENCY }, () => worker()));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (failure) throw failure;
  return out.sort();
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('File traversal was cancelled');
}
