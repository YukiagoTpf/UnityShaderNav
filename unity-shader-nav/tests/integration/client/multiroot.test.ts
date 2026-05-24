import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

function projectA(): string {
  return path.resolve(__dirname, '../../../../server/tests/include/fixtures/projectA');
}

function projectB(): string {
  return path.resolve(__dirname, '../../../../server/tests/workspace/fixtures/projectB');
}

function targetUri(link: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri;
}

async function waitForDefinitions(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (links: Array<vscode.LocationLink | vscode.Location> | undefined) => boolean,
): Promise<Array<vscode.LocationLink | vscode.Location> | undefined> {
  const deadline = Date.now() + 6000;
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

suite('Multi-root isolation', () => {
  test('projectB resolves only projectB globals', async () => {
    const aRoot = projectA();
    const bRoot = projectB();
    await withWorkspaceFolder(aRoot, async () => {
      await withWorkspaceFolder(bRoot, async () => {
        const uri = vscode.Uri.file(path.join(bRoot, 'Assets/Shaders/BMain.shader'));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);

        const lines = doc.getText().split(/\r?\n/);
        const bLine = lines.findIndex((text) => text.includes('OnlyInB()') && text.includes('return'));
        assert.ok(bLine >= 0, 'expected OnlyInB() call in projectB fixture');
        const bCharacter = doc.lineAt(bLine).text.indexOf('OnlyInB()') + 2;
        const bLinks = await waitForDefinitions(
          uri,
          new vscode.Position(bLine, bCharacter),
          (links) => links?.length === 1,
        );

        assert.ok(bLinks && bLinks.length === 1, `expected one OnlyInB definition, got ${bLinks?.length}`);
        assert.ok(targetUri(bLinks[0]).fsPath.startsWith(bRoot), 'OnlyInB target should stay inside projectB');

        const commonLine = lines.findIndex((text) => text.includes('Common()'));
        assert.ok(commonLine >= 0, 'expected Common() probe in projectB fixture');
        const commonCharacter = doc.lineAt(commonLine).text.indexOf('Common()') + 2;
        const commonLinks = await waitForDefinitions(
          uri,
          new vscode.Position(commonLine, commonCharacter),
          (links) => (links?.length ?? 0) > 0,
        );

        assert.strictEqual(commonLinks?.length ?? 0, 0, 'projectA Common must not leak into projectB');
      });
    });
  });
});
