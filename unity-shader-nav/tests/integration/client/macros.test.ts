import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (links: Array<vscode.LocationLink | vscode.Location> | undefined) => boolean,
): Promise<Array<vscode.LocationLink | vscode.Location> | undefined> {
  const deadline = Date.now() + 5000;
  let latest: Array<vscode.LocationLink | vscode.Location> | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

function targetRange(link: vscode.LocationLink | vscode.Location): vscode.Range {
  return (link as vscode.LocationLink).targetRange ?? (link as vscode.Location).range;
}

suite('F12 on macro-declared variable', () => {
  test('jumps from _MainTex usage to TEXTURE2D declaration', async () => {
    const uri = vscode.Uri.file(fixturePath('macros', 'main.hlsl'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const lineText = doc.lineAt(4).text;
    const col = lineText.indexOf('_MainTex');
    assert.ok(col >= 0, 'expected _MainTex usage in fixture');

    const links = await waitForDefinitions(
      uri,
      new vscode.Position(4, col + 3),
      (result) => (result?.length ?? 0) >= 1,
    );

    assert.ok(links && links.length >= 1, 'expected at least one definition');
    assert.strictEqual(targetRange(links[0]).start.line, 0);
  });
});
