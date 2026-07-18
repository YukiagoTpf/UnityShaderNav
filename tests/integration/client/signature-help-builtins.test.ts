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

async function waitForSignatureHelp(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (help: vscode.SignatureHelp | undefined) => boolean,
): Promise<vscode.SignatureHelp | undefined> {
  return waitForEventually(
    `built-in signature help for ${uri.fsPath}`,
    async () => vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider',
      uri,
      position,
      '(',
    ),
    predicate,
    { timeoutMs: 5000, retryMs: 100 },
  );
}

suite('Built-in Signature Help', () => {
  test('shows built-in function signatures in .hlsl files', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const help = await waitForSignatureHelp(
        uri,
        new vscode.Position(22, 16),
        (result) => !!result?.signatures.some((signature) => signature.label.includes('lerp')),
      );

      assert.ok(help, 'expected built-in signature help');
      assert.ok(help.signatures.some((signature) => signature.label.includes('lerp')));
    });
  });

  test('shows all texture member overloads from a later multiline argument', async () => {
    const root = fixturePath('builtin-members');
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(path.join(root, 'Representative.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const help = await waitForSignatureHelp(
        uri,
        positionAfter(doc, '    int2(0, 0)'),
        (result) => (result?.signatures.filter((signature) => (
          signature.label.includes('Sample(')
        )).length ?? 0) === 2,
      );

      assert.ok(help, 'expected texture member signature help');
      assert.strictEqual(
        help.signatures.filter((signature) => signature.label.includes('Sample(')).length,
        2,
      );
      assert.strictEqual(help.activeSignature, 1);
      assert.strictEqual(help.activeParameter, 2);
    });
  });
});
