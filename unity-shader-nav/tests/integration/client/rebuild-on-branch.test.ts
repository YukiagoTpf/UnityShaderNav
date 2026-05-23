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
  const sourceRoot = sourceFixtureRoot();
  await fs.cp(sourceRoot, root, {
    recursive: true,
    filter: (source) => !path.relative(sourceRoot, source).split(path.sep).includes('Library'),
  });
  return root;
}

async function ensureWorkspaceFolder(folderPath: string): Promise<void> {
  if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === folderPath)) return;
  const added = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    0,
    { uri: vscode.Uri.file(folderPath) },
  );
  assert.ok(added, `expected workspace folder to be added: ${folderPath}`);
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

async function waitForNoDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<boolean> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const links = await vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );
    if ((links?.length ?? 0) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

suite('Rebuild on branch switch', () => {
  test('touching .git/HEAD picks up new disk state after rebuild', async () => {
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

      const edit = new vscode.WorkspaceEdit();
      const inserted = '    float4 _branch = BranchOnly();\n';
      edit.insert(mainUri, new vscode.Position(line, 0), inserted);
      assert.ok(await vscode.workspace.applyEdit(edit), 'expected Main.shader edit to apply');
      await new Promise((resolve) => setTimeout(resolve, 800));
      const branchPosition = new vscode.Position(line, inserted.indexOf('BranchOnly') + 2);
      const commonPosition = new vscode.Position(line + 1, doc.lineAt(line + 1).text.indexOf('Common()') + 2);
      const beforeBranch = await vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
        'vscode.executeDefinitionProvider',
        mainUri,
        branchPosition,
      );
      assert.equal(beforeBranch?.length ?? 0, 0, 'BranchOnly should not resolve before rebuild reads new disk state');

      await fs.writeFile(
        path.join(root, 'Assets', 'Shaders', 'Common.hlsl'),
        'float4 BranchOnly() { return 1; }\n',
      );
      await fs.writeFile(headPath, 'ref: refs/heads/feature\n');
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const links = await waitForDefinitions(mainUri, branchPosition);

      assert.ok(links && links.length >= 1, 'expected BranchOnly definition after .git/HEAD rebuild');
      assert.ok(targetUri(links[0]).fsPath.endsWith(path.join('Assets', 'Shaders', 'Common.hlsl')));

      assert.ok(
        await waitForNoDefinitions(mainUri, commonPosition),
        'Common should not resolve after rebuild removed it from disk',
      );
    } finally {
      await removeWorkspaceFolder(root);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
