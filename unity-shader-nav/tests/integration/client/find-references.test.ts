import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
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
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

async function ensureSettingsDirectory(folderPath: string): Promise<void> {
  await fs.mkdir(path.join(folderPath, '.vscode'), { recursive: true });
}

async function waitForReferences(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (locations: vscode.Location[] | undefined) => boolean,
): Promise<vscode.Location[] | undefined> {
  const deadline = Date.now() + 6000;
  let latest: vscode.Location[] | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      uri,
      position,
    );
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latest;
}

function positionOf(doc: vscode.TextDocument, needle: string, offset = 2): vscode.Position {
  const lines = doc.getText().split(/\r?\n/);
  const line = lines.findIndex((text) => text.includes(needle));
  assert.ok(line >= 0, `expected fixture to contain ${needle}`);
  return new vscode.Position(line, doc.lineAt(line).text.indexOf(needle) + offset);
}

suite('Find References', () => {
  test('Shift+F12 on Helper returns references from both user files', async () => {
    const root = fixturePath('refs-project');
    await ensureWorkspaceFolder(root);
    const uri = vscode.Uri.file(path.join(root, 'Assets', 'Shaders', 'Lib.hlsl'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const refs = await waitForReferences(
      uri,
      positionOf(doc, 'Helper'),
      (result) =>
        !!result &&
        result.some((ref) => ref.uri.fsPath.endsWith(path.join('Assets', 'Shaders', 'Use1.hlsl'))) &&
        result.some((ref) => ref.uri.fsPath.endsWith(path.join('Assets', 'Shaders', 'Use2.hlsl'))),
    );

    const paths = refs?.map((ref) => ref.uri.fsPath).join(', ') ?? '<none>';
    assert.ok(refs, `expected reference provider results, got ${paths}`);
    assert.ok(paths.includes(path.join('Assets', 'Shaders', 'Use1.hlsl')), paths);
    assert.ok(paths.includes(path.join('Assets', 'Shaders', 'Use2.hlsl')), paths);
  });

  test('Packages references are excluded by default and included with config flag', async () => {
    const root = fixturePath('refs-project');
    await ensureWorkspaceFolder(root);
    const uri = vscode.Uri.file(path.join(root, 'Assets', 'Shaders', 'Shared.hlsl'));
    const settingsFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(settingsFolder, 'expected integration test workspace folder');
    await ensureSettingsDirectory(settingsFolder.uri.fsPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const position = positionOf(doc, 'SharedRef');
    const config = vscode.workspace.getConfiguration('unityShaderNav');

    try {
      await config.update(
        'findReferences.includePackages',
        false,
        vscode.ConfigurationTarget.Workspace,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const userOnly = await waitForReferences(
        uri,
        position,
        (result) =>
          !!result &&
          result.some((ref) => ref.uri.fsPath.endsWith(path.join('Assets', 'Shaders', 'UserCalls.hlsl'))) &&
          !result.some((ref) => ref.uri.fsPath.includes(`${path.sep}Packages${path.sep}`)),
      );
      const userOnlyPaths = userOnly?.map((ref) => ref.uri.fsPath).join(', ') ?? '<none>';
      assert.ok(userOnly, `expected user-only references, got ${userOnlyPaths}`);

      await config.update(
        'findReferences.includePackages',
        true,
        vscode.ConfigurationTarget.Workspace,
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const withPackages = await waitForReferences(
        uri,
        position,
        (result) =>
          !!result &&
          result.some((ref) => ref.uri.fsPath.endsWith(path.join('Assets', 'Shaders', 'UserCalls.hlsl'))) &&
          result.some((ref) => ref.uri.fsPath.endsWith(path.join('Packages', 'com.example.refs', 'ShaderLibrary', 'PackageCalls.hlsl'))),
      );
      const withPackagePaths = withPackages?.map((ref) => ref.uri.fsPath).join(', ') ?? '<none>';
      assert.ok(withPackages, `expected package reference after enabling setting, got ${withPackagePaths}`);
    } finally {
      await config.update(
        'findReferences.includePackages',
        false,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });
});
