import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

const DEFAULT_ADD_SETTLE_MS = 1500;
const DEFAULT_REMOVE_SETTLE_MS = 500;
const UPDATE_TIMEOUT_MS = 7000;
const RETRY_MS = 100;

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

export async function addWorkspaceFolder(folderPath: string): Promise<vscode.WorkspaceFolder> {
  const existing = findWorkspaceFolder(folderPath);
  if (existing) return existing.folder;

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
      return folder;
    }

    await delay(RETRY_MS);
    const folder = findWorkspaceFolder(folderPath)?.folder;
    if (folder) return folder;
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

export async function withWorkspaceFolder<T>(
  folderPath: string,
  fn: (folder: vscode.WorkspaceFolder) => Promise<T>,
): Promise<T> {
  const folder = await addWorkspaceFolder(folderPath);
  try {
    return await fn(folder);
  } finally {
    await removeWorkspaceFolder(folderPath);
  }
}
