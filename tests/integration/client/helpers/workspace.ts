import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { IndexStatusSnapshot } from '@unity-shader-nav/shared';
import {
  waitForEventuallyWithObserver,
  type EventuallyOptions,
} from './eventually';

export type { EventuallyOptions } from './eventually';

const EXTENSION_ID = 'Yukiago.unity-shader-nav';
const GET_INDEX_STATUS_COMMAND = 'unityShaderNav.getIndexStatus';

type WorkspaceIndexStatus = IndexStatusSnapshot['workspaces'][number];
type TerminalIndexState = 'ready' | 'failed';

export interface WorkspaceFolderHandle {
  folder: vscode.WorkspaceFolder;
  added: boolean;
}

export interface AddWorkspaceFolderOptions {
  expectedState?: TerminalIndexState;
}

let activation: PromiseLike<unknown> | undefined;

async function ensureExtensionActive(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `expected ${EXTENSION_ID} to be installed in the Electron harness`);
  activation ??= extension.activate();
  await activation;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function findWorkspaceFolder(folderPath: string): { folder: vscode.WorkspaceFolder; index: number } | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const index = folders.findIndex((folder) => samePath(folder.uri.fsPath, folderPath));
  return index >= 0 ? { folder: folders[index], index } : undefined;
}

export function indexStatusForFolder(
  snapshot: IndexStatusSnapshot,
  folderPath: string,
): WorkspaceIndexStatus | undefined {
  return snapshot.workspaces.find((workspace) => {
    try {
      return samePath(vscode.Uri.parse(workspace.folderUri).fsPath, folderPath);
    } catch {
      return false;
    }
  });
}

export async function getIndexStatus(): Promise<IndexStatusSnapshot> {
  await ensureExtensionActive();
  const snapshot = await vscode.commands.executeCommand<IndexStatusSnapshot>(GET_INDEX_STATUS_COMMAND);
  if (!snapshot) throw new Error(`${GET_INDEX_STATUS_COMMAND} returned no index status snapshot`);
  return snapshot;
}

export async function waitForEventually<T>(
  description: string,
  query: (status: IndexStatusSnapshot | undefined) => T | PromiseLike<T>,
  predicate: (result: T) => boolean,
  options: EventuallyOptions = {},
): Promise<T> {
  return waitForEventuallyWithObserver(
    { now: Date.now, delay, getStatus: getIndexStatus },
    description,
    query,
    predicate,
    options,
  );
}

export async function waitForIndexStatus(
  description: string,
  predicate: (snapshot: IndexStatusSnapshot) => boolean,
  options: EventuallyOptions = {},
): Promise<IndexStatusSnapshot> {
  return waitForEventually(
    description,
    async (status) => {
      if (!status) throw new Error('No index status was observed in this attempt');
      return status;
    },
    predicate,
    options,
  );
}

async function waitForWorkspaceFolder(
  folderPath: string,
  shouldExist: boolean,
): Promise<vscode.WorkspaceFolder | undefined> {
  return waitForEventually(
    `VS Code workspace folder ${shouldExist ? 'addition' : 'removal'} for ${folderPath}`,
    async () => findWorkspaceFolder(folderPath)?.folder,
    (folder) => shouldExist === !!folder,
  );
}

export async function addWorkspaceFolder(
  folderPath: string,
  options: AddWorkspaceFolderOptions = {},
): Promise<WorkspaceFolderHandle> {
  await ensureExtensionActive();
  const existing = findWorkspaceFolder(folderPath);
  let added = false;

  if (!existing) {
    const folder = await waitForEventually(
      `VS Code to accept workspace folder ${folderPath}`,
      async () => {
        const current = findWorkspaceFolder(folderPath)?.folder;
        if (current) return current;
        if (!added) {
          added = vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            0,
            { uri: vscode.Uri.file(folderPath) },
          );
        }
        return findWorkspaceFolder(folderPath)?.folder;
      },
      (folder) => !!folder,
    );
    assert.ok(folder, `expected workspace folder to exist after adding: ${folderPath}`);
  }

  const folder = await waitForWorkspaceFolder(folderPath, true);
  assert.ok(folder, `expected workspace folder to exist after adding: ${folderPath}`);
  const expectedState = options.expectedState ?? 'ready';
  await waitForIndexStatus(
    `UnityShaderNav workspace ${folderPath} to reach ${expectedState}`,
    (snapshot) => indexStatusForFolder(snapshot, folderPath)?.lifecycle.state === expectedState,
  );
  return { folder, added };
}

export async function removeWorkspaceFolder(folderPath: string): Promise<void> {
  await closeEditorsForFolder(folderPath);
  let removalAccepted = false;

  await waitForEventually(
    `VS Code and UnityShaderNav to remove workspace folder ${folderPath}`,
    async (status) => {
      if (!status) throw new Error('No index status was observed in this attempt');
      const existing = findWorkspaceFolder(folderPath);
      if (existing && !removalAccepted) {
        removalAccepted = vscode.workspace.updateWorkspaceFolders(existing.index, 1);
      }
      return {
        vscodeFolder: findWorkspaceFolder(folderPath)?.folder,
        indexStatus: indexStatusForFolder(status, folderPath),
      };
    },
    ({ vscodeFolder, indexStatus }) => !vscodeFolder && !indexStatus,
  );
}

export async function closeEditorsForFolder(folderPath: string): Promise<void> {
  for (const document of [...vscode.workspace.textDocuments]) {
    if (document.uri.scheme !== 'file' || !isWithinPath(folderPath, document.uri.fsPath)) {
      continue;
    }
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

export async function withWorkspaceFolder<T>(
  folderPath: string,
  fn: (folder: vscode.WorkspaceFolder) => Promise<T>,
): Promise<T> {
  const handle = await addWorkspaceFolder(folderPath);
  try {
    return await fn(handle.folder);
  } finally {
    if (handle.added) await removeWorkspaceFolder(folderPath);
  }
}
