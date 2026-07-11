import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (links: Array<vscode.LocationLink | vscode.Location> | undefined) => boolean,
): Promise<Array<vscode.LocationLink | vscode.Location> | undefined> {
  return waitForEventually(
    'chain member definition',
    async () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    ),
    predicate,
    { timeoutMs: 5000, retryMs: 100 },
  );
}

function targetUri(link: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri;
}

function targetRange(link: vscode.LocationLink | vscode.Location): vscode.Range {
  return (link as vscode.LocationLink).targetRange ?? (link as vscode.Location).range;
}

suite('Chain lookup', () => {
  test('F12 on struct member jumps to member declaration', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const surfaceUri = vscode.Uri.file(fixturePath('chain', 'Surface.hlsl'));
      await vscode.workspace.openTextDocument(surfaceUri);

      const uri = vscode.Uri.file(fixturePath('chain', 'Use.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const line = doc.getText().split(/\r?\n/).findIndex((value) => value.includes('surface.positionWS'));
      assert.ok(line >= 0, 'expected fixture to contain surface.positionWS');
      const col = doc.lineAt(line).text.indexOf('positionWS') + 3;

      const links = await waitForDefinitions(
        uri,
        new vscode.Position(line, col),
        (result) => (result?.length ?? 0) === 1 && targetUri(result![0]).fsPath.endsWith('Surface.hlsl'),
      );

      const actualTargets = links?.map((link) => targetUri(link).fsPath).join(', ') ?? '<none>';
      assert.ok(
        links && links.length === 1,
        `expected exactly one member definition, got ${links?.length ?? 0}: ${actualTargets}`,
      );
      assert.ok(targetUri(links[0]).fsPath.endsWith(path.join('chain', 'Surface.hlsl')));
      assert.strictEqual(targetRange(links[0]).start.line, 1);
    });
  });
});
