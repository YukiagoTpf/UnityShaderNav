import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForCompletion(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (items: vscode.CompletionItem[]) => boolean,
): Promise<vscode.CompletionItem[]> {
  const deadline = Date.now() + 5000;
  let latest: vscode.CompletionItem[] = [];
  while (Date.now() < deadline) {
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      uri,
      position,
    );
    latest = completions?.items ?? [];
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

suite('Built-in Completion', () => {
  test('suggests HLSL built-ins in HLSL files', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const items = await waitForCompletion(
        uri,
        new vscode.Position(3, 11),
        (result) => result.some((item) => item.label === 'normalize'),
      );

      assert.ok(items.some((item) => item.label === 'normalize'), 'expected normalize completion');
    });
  });

  test('suggests ShaderLab built-ins in outer ShaderLab code', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('multi-pass-test.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const items = await waitForCompletion(
        uri,
        new vscode.Position(2, 4),
        (result) => result.some((item) => item.label === 'Blend'),
      );

      assert.ok(items.some((item) => item.label === 'Blend'), 'expected Blend completion');
    });
  });
});
