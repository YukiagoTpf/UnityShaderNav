import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
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
