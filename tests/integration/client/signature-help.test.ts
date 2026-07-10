import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForSignatureHelp(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (help: vscode.SignatureHelp | undefined) => boolean,
): Promise<vscode.SignatureHelp | undefined> {
  const deadline = Date.now() + 5000;
  let latest: vscode.SignatureHelp | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider',
      uri,
      position,
      '(',
    );
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

suite('Signature Help', () => {
  test('shows project function signatures in .hlsl files', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('single-file', 'test.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const help = await waitForSignatureHelp(
        uri,
        new vscode.Position(18, 43),
        (result) => !!result?.signatures.some((signature) => signature.label.includes('combine')),
      );

      assert.ok(help, 'expected signature help');
      assert.ok(help.signatures.some((signature) => signature.label.includes('combine')));
      assert.strictEqual(help.activeParameter, 1);
    });
  });
});
