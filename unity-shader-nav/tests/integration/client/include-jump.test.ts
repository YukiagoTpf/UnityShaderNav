import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

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
  const deadline = Date.now() + 5000;
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

suite('F12 on #include', () => {
  test('opens Common.hlsl', async () => {
    const root = fixtureRoot();
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(path.join(root, 'Assets/Shaders/Main.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const line = doc.getText().split(/\r?\n/).findIndex((text) => text.includes('"Common.hlsl"'));
      assert.ok(line >= 0, 'expected Common.hlsl include line');
      const character = doc.lineAt(line).text.indexOf('Common.hlsl') + 1;

      const links = await waitForDefinitions(uri, new vscode.Position(line, character));

      assert.ok(links && links.length >= 1, 'expected at least one definition');
      assert.ok(targetUri(links[0]).fsPath.endsWith(path.join('Assets', 'Shaders', 'Common.hlsl')));
    });
  });
});
