import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createTestWorkspaceLocation(name: string): {
  readonly rootPath: string;
  readonly folderUri: string;
  readonly fileUri: (...segments: string[]) => string;
} {
  const rootPath = join(tmpdir(), name);
  return {
    rootPath,
    folderUri: pathToFileURL(rootPath).href,
    fileUri: (...segments) => pathToFileURL(join(rootPath, ...segments)).href,
  };
}
