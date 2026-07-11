import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to inspect ${path}: ${detail}`, { cause: error });
  }
}

export async function detectUnityRoot(startDir: string): Promise<string | null> {
  let current = startDir;

  for (;;) {
    const hasAssets = await dirExists(join(current, 'Assets'));
    const hasProjectSettings = await dirExists(join(current, 'ProjectSettings'));
    if (hasAssets && hasProjectSettings) return current;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
