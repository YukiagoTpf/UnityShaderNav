import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForSemanticTokens(uri: vscode.Uri): Promise<vscode.SemanticTokens | undefined> {
  return waitForEventually(
    `semantic tokens for ${uri.fsPath}`,
    async () => vscode.commands.executeCommand<vscode.SemanticTokens>(
      'vscode.provideDocumentSemanticTokens',
      uri,
    ),
    (tokens) => !!tokens && tokens.data.length > 0,
    { timeoutMs: 6000, retryMs: 150 },
  );
}

suite('Semantic Tokens', () => {
  test('serves semantic tokens for mixed ShaderLab and HLSL shader files', async () => {
    const root = fixturePath('highlighting');
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(path.join(root, 'Mixed.shader'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const tokens = await waitForSemanticTokens(uri);

      assert.ok(tokens, 'expected semantic tokens for Mixed.shader');
      assert.ok(tokens.data.length > 0, 'expected semantic token data for Mixed.shader');
    });
  });
});
