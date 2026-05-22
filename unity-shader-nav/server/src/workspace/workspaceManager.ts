import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection } from 'vscode-languageserver/node';
import type { ExtensionSettings } from '@unity-shader-nav/shared';
import { Workspace } from './workspace';

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class WorkspaceManager {
  private readonly byFolder = new Map<string, Workspace>();

  list(): Workspace[] {
    return [...this.byFolder.values()];
  }

  workspaceFor(fileUri: string): Workspace | undefined {
    try {
      const filePath = fileURLToPath(fileUri);
      let best: { workspace: Workspace; length: number } | undefined;

      for (const workspace of this.byFolder.values()) {
        const folderPath = fileURLToPath(workspace.folderUri);
        if (!containsPath(folderPath, filePath)) continue;
        if (!best || folderPath.length > best.length) {
          best = { workspace, length: folderPath.length };
        }
      }

      return best?.workspace;
    } catch {
      return undefined;
    }
  }

  async addFolder(
    folderUri: string,
    settings: ExtensionSettings,
    connection: Connection,
    globalStorageDir?: string,
  ): Promise<void> {
    if (this.byFolder.has(folderUri)) return;
    const workspace = new Workspace(folderUri, settings);
    this.byFolder.set(folderUri, workspace);
    await workspace.bootstrap(connection, globalStorageDir);
  }

  removeFolder(folderUri: string): void {
    this.byFolder.delete(folderUri);
  }
}
