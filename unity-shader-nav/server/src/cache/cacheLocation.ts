import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface CacheLocationInput {
  unityProjectRoot: string | undefined;
  workspaceFolderUri: string;
  globalStorageDir: string | undefined;
}

export function chooseCacheDir(input: CacheLocationInput): string | null {
  if (input.unityProjectRoot) {
    return join(input.unityProjectRoot, 'Library', 'UnityShaderNavCache');
  }

  if (input.globalStorageDir) {
    const hash = createHash('sha1')
      .update(input.workspaceFolderUri)
      .digest('hex')
      .slice(0, 16);
    return join(input.globalStorageDir, 'standalone', hash);
  }

  return null;
}
