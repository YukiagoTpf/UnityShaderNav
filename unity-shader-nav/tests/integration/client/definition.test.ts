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

suite('F12 single-file', () => {
  test('jumps from call to declaration in .hlsl', async () => {
    const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const links = await waitForDefinitions(
      uri,
      new vscode.Position(3, 12),
      (result) => (result?.length ?? 0) >= 1,
    );

    assert.ok(links && links.length >= 1, 'expected at least one definition');
    assert.strictEqual(targetRange(links[0]).start.line, 0);
  });

  test('jumps from parameter usage to parameter declaration in .hlsl', async () => {
    const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const links = await waitForDefinitions(
      uri,
      new vscode.Position(0, 35),
      (result) => (result?.length ?? 0) === 1,
    );

    assert.ok(links && links.length === 1, 'expected one parameter definition');
    assert.strictEqual(targetRange(links[0]).start.line, 0);
    assert.strictEqual(targetRange(links[0]).start.character, 19);
  });

  test('multi-pass .shader returns 2 candidates for vert', async () => {
    const uri = vscode.Uri.file(fixturePath('multi-pass-test.shader'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const lines = doc.getText().split(/\r?\n/);
    const callLine = lines.findIndex((line) => line.includes('main_forward()') && line.includes('vert();'));
    assert.ok(callLine >= 0, 'expected a vert() call site in fixture');
    const callCol = lines[callLine].indexOf('vert();') + 1;

    const links = await waitForDefinitions(
      uri,
      new vscode.Position(callLine, callCol),
      (result) => result?.length === 2,
    );

    assert.ok(links, 'definition provider returned null');
    assert.strictEqual(links.length, 2, `expected 2 vert candidates, got ${links.length}`);

    const linesOut = links.map((link) => targetRange(link).start.line);
    assert.notStrictEqual(linesOut[0], linesOut[1]);
  });
});
