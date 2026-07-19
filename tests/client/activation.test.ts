import * as assert from 'node:assert';
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  OPEN_VARIANT_COST_DOCUMENTATION_COMMAND,
  SHOW_VARIANT_COMPARISON_COMMAND,
} from '@unity-shader-nav/shared';

const EXT_ID = 'Yukiago.unity-shader-nav';

function findExt(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.getExtension(EXT_ID);
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
  test('runs from one disposable short-path harness', () => {
    const harnessRoot = process.env.USN_HARNESS_ROOT;
    assert.ok(harnessRoot, 'Electron tests must run through the staged harness');
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');

    assert.ok(isWithin(harnessRoot, ext.extensionPath), 'extension path must be staged');
    assert.ok(isWithin(harnessRoot, __dirname), 'compiled tests must be staged');
    assert.ok(isWithin(harnessRoot, os.tmpdir()), 'test temp state must stay in the harness');
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      assert.ok(isWithin(harnessRoot, folder.uri.fsPath), 'workspace must be staged');
    }
  });

  test('manifest declares onLanguage activation for shaderlab, hlsl, and shadergraph', () => {
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
    assert.ok(
      events.includes('onLanguage:shadergraph'),
      `expected onLanguage:shadergraph in activationEvents, got ${JSON.stringify(events)}`,
    );
  });

  test('manifest exposes standard language-server trace levels', () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');
    const trace = ext.packageJSON.contributes?.configuration?.properties?.[
      'unityShaderNav.trace.server'
    ];
    assert.deepStrictEqual(trace?.enum, ['off', 'messages', 'verbose']);
    assert.strictEqual(trace?.default, 'off');
  });

  test('manifest contributes user-facing index status and output commands', () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');
    const commands: Array<{ command?: string }> = ext.packageJSON.contributes?.commands ?? [];
    const ids = commands.map(({ command }) => command);
    assert.ok(ids.includes('unityShaderNav.showIndexStatus'));
    assert.ok(ids.includes('unityShaderNav.showOutput'));
    assert.ok(ids.includes('unityShaderNav.showMaterialContext'));
    assert.ok(ids.includes(SHOW_VARIANT_COMPARISON_COMMAND));
  });

  test('opening a .shader document triggers activation via activationEvents', async () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');
    assert.strictEqual(ext.isActive, false, 'activation smoke must begin with the extension inactive');

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

  test('activation registers the status and Variant cost documentation actions', async () => {
    const ext = findExt();
    assert.ok(ext, 'extension manifest must be loaded');
    await ext.activate();
    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes('unityShaderNav.showIndexStatus'));
    assert.ok(registered.includes('unityShaderNav.showOutput'));
    assert.ok(registered.includes('unityShaderNav.pickIncludePointContext'));
    assert.ok(registered.includes('unityShaderNav.showMaterialContext'));
    assert.ok(registered.includes(OPEN_VARIANT_COST_DOCUMENTATION_COMMAND));
    assert.ok(registered.includes(SHOW_VARIANT_COMPARISON_COMMAND));
  });
});

function isWithin(root: string, candidate: string): boolean {
  const relativePath = path.relative(realpathSync(root), realpathSync(candidate));
  return relativePath === ''
    || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
