import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addWorkspaceFolder,
  removeWorkspaceFolder,
  waitForEventually,
} from './helpers/workspace';

function fixtureRoot(): string {
  return path.resolve(__dirname, '../../../../server/tests/include/fixtures/projectA');
}

function targetUri(link: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri;
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<Array<vscode.LocationLink | vscode.Location> | undefined> {
  return waitForEventually(
    'cross-file definition',
    async () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    ),
    (links) => (links?.length ?? 0) > 0,
    { timeoutMs: 6000, retryMs: 100 },
  );
}

suite('F12 cross-file', () => {
  let workspace: Awaited<ReturnType<typeof addWorkspaceFolder>> | undefined;

  suiteSetup(async () => {
    workspace = await addWorkspaceFolder(fixtureRoot());
  });

  suiteTeardown(async () => {
    if (workspace?.added) await removeWorkspaceFolder(fixtureRoot());
  });

  test('jumps to Common.hlsl', async () => {
    const root = fixtureRoot();
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
