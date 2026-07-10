import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

async function waitForHighlights(
  uri: vscode.Uri,
  position: vscode.Position,
  predicate: (highlights: vscode.DocumentHighlight[] | undefined) => boolean,
): Promise<vscode.DocumentHighlight[] | undefined> {
  const deadline = Date.now() + 6000;
  let latest: vscode.DocumentHighlight[] | undefined;
  while (Date.now() < deadline) {
    latest = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
      'vscode.executeDocumentHighlights',
      uri,
      position,
    );
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latest;
}

function rangeKey(range: vscode.Range): string {
  return `${range.start.line}:${range.start.character}-${range.end.character}`;
}

suite('Document Highlight', () => {
  test('highlights receiver member access through the VSCode command chain', async () => {
    const root = fixturePath('refs-project');
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(path.join(root, 'Assets', 'Shaders', 'Highlight.hlsl'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const highlights = await waitForHighlights(
        uri,
        new vscode.Position(4, 12),
        (result) => {
          const keys = new Set((result ?? []).map((highlight) => rangeKey(highlight.range)));
          return keys.has('4:12-22') && keys.has('6:19-29');
        },
      );

      const keys = (highlights ?? []).map((highlight) => rangeKey(highlight.range)).sort();
      assert.ok(highlights, `expected document highlight results, got ${keys.join(', ')}`);
      assert.deepEqual(keys, ['4:12-22', '6:19-29']);
    });
  });
});
