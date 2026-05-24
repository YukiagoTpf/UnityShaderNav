import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

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

function targetUri(link: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri;
}

function targetRange(link: vscode.LocationLink | vscode.Location): vscode.Range {
  return (link as vscode.LocationLink).targetRange ?? (link as vscode.Location).range;
}

suite('Macro definitions', () => {
  test('F12 on SAMPLE_TEXTURE2D jumps to #define', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const macrosUri = vscode.Uri.file(fixturePath('macros-define', 'Macros.hlsl'));
      await vscode.workspace.openTextDocument(macrosUri);

      const uri = vscode.Uri.file(fixturePath('macros-define', 'Use.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const line = doc.getText().split(/\r?\n/).findIndex((text) => text.includes('SAMPLE_TEXTURE2D('));
      assert.ok(line >= 0, 'expected SAMPLE_TEXTURE2D usage in fixture');
      const character = doc.lineAt(line).text.indexOf('SAMPLE_TEXTURE2D') + 4;

      const links = await waitForDefinitions(
        uri,
        new vscode.Position(line, character),
        (result) =>
          (result?.length ?? 0) >= 1 &&
          targetUri(result![0]).fsPath.endsWith(path.join('macros-define', 'Macros.hlsl')),
      );

      assert.ok(links && links.length >= 1, 'expected at least one macro definition');
      assert.ok(targetUri(links[0]).fsPath.endsWith(path.join('macros-define', 'Macros.hlsl')));
      assert.strictEqual(targetRange(links[0]).start.line, 0);
    });
  });
});
