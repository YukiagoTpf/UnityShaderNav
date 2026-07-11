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

interface DecodedToken {
  readonly line: number;
  readonly character: number;
  readonly length: number;
  readonly typeIndex: number;
}

function decodeTokens(tokens: vscode.SemanticTokens): DecodedToken[] {
  const decoded: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    const lineDelta = tokens.data[index];
    line += lineDelta;
    character = lineDelta === 0
      ? character + tokens.data[index + 1]
      : tokens.data[index + 1];
    decoded.push({
      line,
      character,
      length: tokens.data[index + 2],
      typeIndex: tokens.data[index + 3],
    });
  }
  return decoded;
}

function expectToken(
  document: vscode.TextDocument,
  tokens: readonly DecodedToken[],
  text: string,
  typeIndex: number,
): void {
  const line = document.getText().split(/\r?\n/)
    .findIndex((value) => value.includes(text));
  assert.ok(line >= 0, 'expected fixture token ' + text);
  const character = document.lineAt(line).text.indexOf(text);
  assert.ok(tokens.some((token) => (
    token.line === line
    && token.character === character
    && token.length === text.length
    && token.typeIndex === typeIndex
  )), 'expected semantic token ' + text + ' with type index ' + typeIndex);
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
      const decoded = decodeTokens(tokens);
      // Stable server legend: type=0, keyword=6.
      expectToken(doc, decoded, 'UsePass', 6);
      expectToken(doc, decoded, '2DArray', 0);
      expectToken(doc, decoded, 'CubeArray', 0);
    });
  });
});
