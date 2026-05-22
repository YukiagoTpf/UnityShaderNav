import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('UnityShaderNav activation', () => {
  test('extension activates on .shader open', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'shaderlab',
      content: 'Shader "Foo" { }',
    });
    await vscode.window.showTextDocument(doc);

    const ext = vscode.extensions.all.find(
      (e) => e.packageJSON?.name === 'unity-shader-nav',
    );
    assert.ok(ext, 'extension manifest must be loaded');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});
