import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

function fixtureRoot(): string {
  return path.resolve(__dirname, '../../../../server/tests/include/fixtures/projectA');
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

suite('F12 cross-file', () => {
  test('jumps to Common.hlsl', async () => {
    const root = fixtureRoot();
    await ensureWorkspaceFolder(root);
    const uri = vscode.Uri.file(path.join(root, 'Assets/Shaders/Main.shader'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const line = doc.getText().split(/\r?\n/).findIndex((text) => text.includes('return Common()'));
    assert.ok(line >= 0, 'expected Common() call in fixture');
    const character = doc.lineAt(line).text.indexOf('Common()') + 2;

    const links = await waitForDefinitions(uri, new vscode.Position(line, character));

    assert.ok(links && links.length >= 1, 'expected at least one Common definition');
    assert.ok(targetUri(links[0]).fsPath.endsWith(path.join('Assets', 'Shaders', 'Common.hlsl')));
  });

  test('jumps to Core() in Packages', async () => {
    const root = fixtureRoot();
    await ensureWorkspaceFolder(root);
    const uri = vscode.Uri.file(path.join(root, 'Assets/Shaders/Main.shader'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const line = doc.getText().split(/\r?\n/).findIndex((text) => text.includes('Core()'));
    assert.ok(line >= 0, 'expected Core() call in fixture');
    const character = doc.lineAt(line).text.indexOf('Core()') + 2;

    const links = await waitForDefinitions(uri, new vscode.Position(line, character));

    assert.ok(links && links.length >= 1, 'expected at least one Core definition');
    const target = targetUri(links[0]).fsPath;
    assert.ok(target.endsWith(path.join('ShaderLibrary', 'Core.hlsl')), `expected Core.hlsl, got ${target}`);
    assert.ok(
      target.includes(`${path.sep}Packages${path.sep}com.example.urp${path.sep}`),
      `expected target under Packages/com.example.urp, got ${target}`,
    );
  });
});
