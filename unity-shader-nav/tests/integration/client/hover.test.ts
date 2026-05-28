import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForHover(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (hovers: vscode.Hover[] | undefined) => boolean,
): Promise<vscode.Hover[] | undefined> {
  const deadline = Date.now() + 5000;
  let latest: vscode.Hover[] | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      position,
    );
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

function hoverText(hovers: vscode.Hover[]): string {
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
    .join('\n');
}

suite('hover', () => {
  test('hovers a project function from a call site in .hlsl', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      // Line 3: '    return helper(x);' — 'helper' starts at column 11.
      const hovers = await waitForHover(
        uri,
        new vscode.Position(3, 13),
        (result) => (result?.length ?? 0) >= 1,
      );

      assert.ok(hovers && hovers.length >= 1, 'expected at least one hover');
      const text = hoverText(hovers);
      assert.ok(text.includes('```hlsl'), `expected fenced HLSL block, got: ${text}`);
      assert.ok(text.includes('helper'), `expected helper in hover body, got: ${text}`);
    });
  });

  test('hovers a built-in catalog entry (lerp) when no project symbol matches', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      // Line 22: '    return lerp(a, b, 0.5);' — 'lerp' starts at column 11.
      const hovers = await waitForHover(
        uri,
        new vscode.Position(22, 13),
        (result) => (result?.length ?? 0) >= 1,
      );

      assert.ok(hovers && hovers.length >= 1, 'expected at least one built-in hover');
      const text = hoverText(hovers);
      assert.ok(text.includes('lerp'), `expected 'lerp' in built-in hover body, got: ${text}`);
      assert.ok(
        /_(HLSL|Unity|URP|ShaderLab) built-in_|_HLSL semantic_/.test(text),
        `expected built-in/semantic footer label, got: ${text}`,
      );
    });
  });
});
