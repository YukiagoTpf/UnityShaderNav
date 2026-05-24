import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

const DEFAULT_ADD_SETTLE_MS = 1500;
const DEFAULT_REMOVE_SETTLE_MS = 500;
const UPDATE_TIMEOUT_MS = 7000;
const RETRY_MS = 100;

export interface WorkspaceFolderHandle {
  folder: vscode.WorkspaceFolder;
  added: boolean;
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

async function waitForWorkspaceFolder(
  folderPath: string,
  shouldExist: boolean,
): Promise<vscode.WorkspaceFolder | undefined> {
  const deadline = Date.now() + UPDATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const existing = findWorkspaceFolder(folderPath);
    if (shouldExist === !!existing) return existing?.folder;
    await delay(RETRY_MS);
  }
  return findWorkspaceFolder(folderPath)?.folder;
}

export async function addWorkspaceFolder(folderPath: string): Promise<WorkspaceFolderHandle> {
  const existing = findWorkspaceFolder(folderPath);
  if (existing) return { folder: existing.folder, added: false };

  const deadline = Date.now() + UPDATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const added = vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0,
      0,
      { uri: vscode.Uri.file(folderPath) },
    );
    if (added) {
      const folder = await waitForWorkspaceFolder(folderPath, true);
      assert.ok(folder, `expected workspace folder to exist after adding: ${folderPath}`);
      await delay(DEFAULT_ADD_SETTLE_MS);
      return { folder, added: true };
    }

    await delay(RETRY_MS);
    const folder = findWorkspaceFolder(folderPath)?.folder;
    if (folder) return { folder, added: false };
  }

  assert.fail(`expected workspace folder to be added: ${folderPath}`);
}

export async function removeWorkspaceFolder(folderPath: string): Promise<void> {
  const deadline = Date.now() + UPDATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const existing = findWorkspaceFolder(folderPath);
    if (!existing) return;

    const removed = vscode.workspace.updateWorkspaceFolders(existing.index, 1);
    if (removed) {
      await waitForWorkspaceFolder(folderPath, false);
      await delay(DEFAULT_REMOVE_SETTLE_MS);
      assert.equal(findWorkspaceFolder(folderPath), undefined, `expected workspace folder to be removed: ${folderPath}`);
      return;
    }

    await delay(RETRY_MS);
  }

  assert.fail(`expected workspace folder to be removed: ${folderPath}`);
}

export async function closeEditorsForFolder(folderPath: string): Promise<void> {
  for (const editor of [...vscode.window.visibleTextEditors]) {
    if (!isWithinPath(folderPath, editor.document.uri.fsPath)) {
      continue;
    }
    await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
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
