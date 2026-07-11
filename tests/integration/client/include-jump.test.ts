import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

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
    'include definition',
    async () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    ),
    (links) => (links?.length ?? 0) > 0,
    { timeoutMs: 5000, retryMs: 100 },
  );
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
