import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function ensureWorkspaceFolder(folderPath: string): Promise<void> {
  if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === folderPath)) return;
  const added = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    0,
    { uri: vscode.Uri.file(folderPath) },
  );
  if (!added) return;
  await new Promise((resolve) => setTimeout(resolve, 1000));
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

suite('Chain lookup', () => {
  test('F12 on struct member jumps to member declaration', async () => {
    await ensureWorkspaceFolder(fixturePath());
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
