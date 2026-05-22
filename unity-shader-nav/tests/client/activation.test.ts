import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXT_NAME = 'unity-shader-nav';

function findExt(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.all.find((e) => e.packageJSON?.name === EXT_NAME);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

suite('UnityShaderNav activation', () => {
  test('manifest declares onLanguage activation for shaderlab and hlsl', () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');
    const events: string[] = ext.packageJSON.activationEvents ?? [];
    assert.ok(
      events.includes('onLanguage:shaderlab'),
      `expected onLanguage:shaderlab in activationEvents, got ${JSON.stringify(events)}`,
    );
    assert.ok(
      events.includes('onLanguage:hlsl'),
      `expected onLanguage:hlsl in activationEvents, got ${JSON.stringify(events)}`,
    );
  });

  test('opening a .shader document triggers activation via activationEvents', async () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');

    // Open the shader doc without calling ext.activate() — rely on the
    // declared onLanguage:shaderlab event to drive activation.
    const doc = await vscode.workspace.openTextDocument({
      language: 'shaderlab',
      content: 'Shader "Foo" { }',
    });
    await vscode.window.showTextDocument(doc);

    const activated = await waitFor(() => ext.isActive === true);
    assert.strictEqual(
      activated, true,
      'expected onLanguage:shaderlab to activate the extension within 5s',
    );
  });
});
