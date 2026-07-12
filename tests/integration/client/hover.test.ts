import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForHover(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (hovers: vscode.Hover[] | undefined) => boolean,
): Promise<vscode.Hover[] | undefined> {
  return waitForEventually(
    'hover result',
    async () => vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      uri,
      position,
    ),
    predicate,
    { timeoutMs: 5000, retryMs: 100 },
  );
}

function hoverText(hovers: vscode.Hover[]): string {
  return hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
    .join('\n');
}

suite('hover', () => {
  test('shows sourced ShaderLab Quick Documentation in the Extension Host', async () => {
    const root = fixturePath('shaderlab-names');
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(fixturePath(
        'shaderlab-names',
        'Assets',
        'Consumer.shader',
      ));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      const line = doc.getText().split(/\r?\n/)
        .findIndex((candidate) => candidate.includes('Cull Back'));
      assert.ok(line >= 0, 'expected Cull render state fixture');
      const character = doc.lineAt(line).text.indexOf('Cull') + 1;

      const hovers = await waitForHover(
        uri,
        new vscode.Position(line, character),
        (result) => result ? hoverText(result).includes('SL-Cull.html') : false,
      );
      assert.ok(hovers, 'expected ShaderLab Quick Documentation');
      const text = hoverText(hovers);
      assert.ok(text.includes('Curated fallback'), text);
      assert.ok(text.includes('Unity 2022.3 manual'), text);
      assert.ok(text.includes('/2022.3/Documentation/Manual/SL-Cull.html'), text);
    });
  });

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
