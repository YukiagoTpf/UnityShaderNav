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

async function waitForDocumentSymbols(
  uri: vscode.Uri,
  predicate: (symbols: vscode.DocumentSymbol[] | undefined) => boolean,
): Promise<vscode.DocumentSymbol[] | undefined> {
  const deadline = Date.now() + 5000;
  let latest: vscode.DocumentSymbol[] | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

function childNamed(
  symbols: readonly vscode.DocumentSymbol[] | undefined,
  name: string,
): vscode.DocumentSymbol | undefined {
  return symbols?.find((symbol) => symbol.name === name);
}

suite('Document Symbols', () => {
  test('outline contains function, struct children, cbuffer, and pragma in .hlsl', async () => {
    await ensureWorkspaceFolder(fixturePath());
    const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const symbols = await waitForDocumentSymbols(uri, (result) =>
      !!childNamed(result, 'helper')
      && !!childNamed(result, 'Attributes')
      && !!childNamed(result, 'UnityPerMaterial')
      && !!childNamed(result, '#pragma main'),
    );

    assert.ok(symbols, 'document symbol provider returned no symbols');
    const attributes = childNamed(symbols, 'Attributes');
    assert.ok(
      childNamed(attributes?.children, 'positionOS'),
      'expected struct member under Attributes',
    );
  });

  test('.shader outline shows Shader > SubShader > Pass > entry', async () => {
    await ensureWorkspaceFolder(fixturePath());
    const uri = vscode.Uri.file(fixturePath('multi-pass-test.shader'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const symbols = await waitForDocumentSymbols(uri, (result) => {
      const shader = childNamed(result, 'Shader "Test/MultiPassDefn"');
      const subshader = childNamed(shader?.children, 'SubShader');
      const forward = childNamed(subshader?.children, 'Pass "ForwardLit"');
      return !!childNamed(forward?.children, 'vert');
    });

    const shader = childNamed(symbols, 'Shader "Test/MultiPassDefn"');
    assert.ok(shader, 'expected Shader root symbol');
    const subshader = childNamed(shader.children, 'SubShader');
    assert.ok(subshader, 'expected SubShader child');
    const forward = childNamed(subshader.children, 'Pass "ForwardLit"');
    assert.ok(forward, 'expected ForwardLit pass child');
    assert.ok(childNamed(forward.children, 'vert'), 'expected vert under ForwardLit');
  });
});
