import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { closeEditorsForFolder, withWorkspaceFolder } from './helpers/workspace';

function sourceFixtureRoot(): string {
  return path.resolve(__dirname, '../../../../server/tests/include/fixtures/projectA');
}

async function makeProjectCopy(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usn-lifecycle-'));
  const sourceRoot = sourceFixtureRoot();
  await fs.cp(sourceRoot, root, {
    recursive: true,
    filter: (source) => !path.relative(sourceRoot, source).split(path.sep).includes('Library'),
  });
  return root;
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

suite('Lifecycle: edit triggers reindex', () => {
  test('adding a new function to Common.hlsl makes it discoverable from Main.shader', async () => {
    const root = await makeProjectCopy();
    try {
      await withWorkspaceFolder(root, async () => {
        try {
          const commonPath = path.join(root, 'Assets', 'Shaders', 'Common.hlsl');
          const mainUri = vscode.Uri.file(path.join(root, 'Assets', 'Shaders', 'Main.shader'));
          const before = await fs.readFile(commonPath, 'utf8');

          const mainDoc = await vscode.workspace.openTextDocument(mainUri);
          await vscode.window.showTextDocument(mainDoc);
          const endLine = mainDoc.getText().split(/\r?\n/).findIndex((line) => line.trim() === 'ENDHLSL');
          assert.ok(endLine >= 0, 'expected ENDHLSL in Main.shader');

          const edit = new vscode.WorkspaceEdit();
          const inserted = '    float4 _z = NewlyAdded();\n';
          edit.insert(mainUri, new vscode.Position(endLine, 0), inserted);
          assert.ok(await vscode.workspace.applyEdit(edit), 'expected Main.shader edit to apply');
          await new Promise((resolve) => setTimeout(resolve, 800));

          const unresolved = await vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
            'vscode.executeDefinitionProvider',
            mainUri,
            new vscode.Position(endLine, inserted.indexOf('NewlyAdded') + 2),
          );
          assert.equal(unresolved?.length ?? 0, 0, 'NewlyAdded should not resolve before external file change');

          await fs.writeFile(commonPath, `${before}\nfloat4 NewlyAdded() { return 1; }\n`);
          await new Promise((resolve) => setTimeout(resolve, 1000));

          const links = await waitForDefinitions(
            mainUri,
            new vscode.Position(endLine, inserted.indexOf('NewlyAdded') + 2),
          );

          assert.ok(links && links.length >= 1, 'expected NewlyAdded definition');
          assert.ok(targetUri(links[0]).fsPath.endsWith(path.join('Assets', 'Shaders', 'Common.hlsl')));
        } finally {
          await closeEditorsForFolder(root);
        }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
