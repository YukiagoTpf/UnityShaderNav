import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

function positionAfter(document: vscode.TextDocument, needle: string): vscode.Position {
  const offset = document.getText().indexOf(needle);
  assert.ok(offset >= 0, `expected fixture text ${needle}`);
  return document.positionAt(offset + needle.length);
}

async function waitForCompletion(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (items: vscode.CompletionItem[]) => boolean,
): Promise<vscode.CompletionItem[]> {
  return waitForEventually(
    'built-in completion items',
    async () => {
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        position,
      );
      return completions?.items ?? [];
    },
    predicate,
    { timeoutMs: 5000, retryMs: 100 },
  );
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

  test('suggests receiver-owned texture, vector, and matrix members', async () => {
    const root = fixturePath('builtin-members');
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(path.join(root, 'Representative.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const textureItems = await waitForCompletion(
        uri,
        positionAfter(doc, 'texture.Sam'),
        (result) => result.some((item) => item.label === 'Sample'),
      );
      assert.strictEqual(
        textureItems.filter((item) => item.label === 'Sample').length,
        1,
        'expected one Sample completion despite signature overloads',
      );

      const swizzles = await waitForCompletion(
        uri,
        positionAfter(doc, 'color.xy'),
        (result) => result.some((item) => item.label === 'xy'),
      );
      assert.ok(swizzles.some((item) => item.label === 'xy'), 'expected float4 xy swizzle');

      const matrixMembers = await waitForCompletion(
        uri,
        positionAfter(doc, 'transform._m2'),
        (result) => result.some((item) => item.label === '_m23'),
      );
      assert.ok(
        matrixMembers.some((item) => item.label === '_m23'),
        'expected bounded float3x4 component _m23',
      );
      assert.ok(
        !matrixMembers.some((item) => item.label === '_m30'),
        'did not expect out-of-bounds float3x4 component _m30',
      );
    });
  });
});
