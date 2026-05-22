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

function targetRange(link: vscode.LocationLink | vscode.Location): vscode.Range {
  return (link as vscode.LocationLink).targetRange ?? (link as vscode.Location).range;
}

suite('F12 on macro-declared variable', () => {
  test('jumps from _MainTex usage to TEXTURE2D declaration', async () => {
    await ensureWorkspaceFolder(fixturePath());
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

  test('reindexes an already-open file when declarationMacros changes', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected integration test workspace folder');

    const uri = vscode.Uri.joinPath(folder.uri, 'custom-macro-settings.hlsl');
    const config = vscode.workspace.getConfiguration('unityShaderNav', folder.uri);
    const text = [
      'MY_TEX2D(_CustomTex);',
      'float4 main() { return _CustomTex.Sample(sampler_CustomTex, float2(0, 0)); }',
    ].join('\n');

    try {
      await config.update('declarationMacros', [], vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      assert.strictEqual(doc.languageId, 'hlsl', 'test document should be handled by the HLSL language client');

      const usageCol = doc.lineAt(1).text.indexOf('_CustomTex');
      assert.ok(usageCol >= 0, 'expected _CustomTex usage in test document');
      const position = new vscode.Position(1, usageCol + 3);

      const before = await vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
        'vscode.executeDefinitionProvider',
        uri,
        position,
      );
      assert.strictEqual(before?.length ?? 0, 0, 'custom macro should not resolve before setting update');

      let sawConfigEvent = false;
      const disposable = vscode.workspace.onDidChangeConfiguration((event) => {
        sawConfigEvent = sawConfigEvent || event.affectsConfiguration('unityShaderNav.declarationMacros');
      });
      await config.update(
        'declarationMacros',
        [{ pattern: 'MY_TEX2D($name)', kind: 'variable' }],
        vscode.ConfigurationTarget.Workspace,
      );
      disposable.dispose();
      assert.strictEqual(sawConfigEvent, true, 'VSCode should emit declarationMacros configuration changes');
      assert.deepStrictEqual(
        vscode.workspace.getConfiguration('unityShaderNav', folder.uri).get('declarationMacros'),
        [{ pattern: 'MY_TEX2D($name)', kind: 'variable' }],
        'updated declarationMacros should be visible from workspace configuration',
      );

      const links = await waitForDefinitions(
        uri,
        position,
        (result) => (result?.length ?? 0) >= 1 && targetRange(result![0]).start.line === 0,
      );

      assert.ok(links && links.length >= 1, 'expected definition after declarationMacros update');
      assert.strictEqual(targetRange(links[0]).start.line, 0);
    } finally {
      await config.update('declarationMacros', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.delete(uri, { useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs
        .delete(vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json'), { useTrash: false })
        .then(undefined, () => undefined);
      await vscode.workspace.fs
        .delete(vscode.Uri.joinPath(folder.uri, '.vscode'), { useTrash: false })
        .then(undefined, () => undefined);
    }
  });
});
