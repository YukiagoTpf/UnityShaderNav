import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

function sourceFixtureRoot(): string {
  return path.resolve(__dirname, '../../../../server/tests/include/fixtures/projectA');
}

async function makeProjectCopy(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usn-rebuild-'));
  await fs.cp(sourceFixtureRoot(), root, { recursive: true });
  return root;
}

async function ensureWorkspaceFolder(folderPath: string): Promise<void> {
  if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === folderPath)) return;
  const added = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    0,
    { uri: vscode.Uri.file(folderPath) },
  );
  if (!added) return;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function removeWorkspaceFolder(folderPath: string): Promise<void> {
  const index = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.uri.fsPath === folderPath) ?? -1;
  if (index >= 0) {
    vscode.workspace.updateWorkspaceFolders(index, 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function targetUri(link: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri;
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<Array<vscode.LocationLink | vscode.Location> | undefined> {
  const deadline = Date.now() + 6000;
  let latest: Array<vscode.LocationLink | vscode.Location> | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );
    if ((latest?.length ?? 0) > 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

suite('Rebuild on branch switch', () => {
  test('touching .git/HEAD keeps cross-file index usable after rebuild', async () => {
    const root = await makeProjectCopy();
    try {
      const gitDir = path.join(root, '.git');
      const headPath = path.join(gitDir, 'HEAD');
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(headPath, 'ref: refs/heads/main\n');

      await ensureWorkspaceFolder(root);
      const mainUri = vscode.Uri.file(path.join(root, 'Assets', 'Shaders', 'Main.shader'));
      const doc = await vscode.workspace.openTextDocument(mainUri);
      await vscode.window.showTextDocument(doc);
      const line = doc.getText().split(/\r?\n/).findIndex((text) => text.includes('return Common()'));
      assert.ok(line >= 0, 'expected Common() call in fixture');
      const position = new vscode.Position(line, doc.lineAt(line).text.indexOf('Common()') + 2);

      await fs.writeFile(headPath, 'ref: refs/heads/feature\n');
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const links = await waitForDefinitions(mainUri, position);

      assert.ok(links && links.length >= 1, 'expected Common definition after .git/HEAD change');
      assert.ok(targetUri(links[0]).fsPath.endsWith(path.join('Assets', 'Shaders', 'Common.hlsl')));
    } finally {
      await removeWorkspaceFolder(root);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
