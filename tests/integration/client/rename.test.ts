import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures', ...segments);
}

suite('Workspace Rename', () => {
  test('prepares and returns cross-file edits for an indexed HLSL function', async () => {
    const root = fixturePath('refs-project');
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(path.join(root, 'Assets', 'Shaders', 'Lib.hlsl'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const position = new vscode.Position(0, document.lineAt(0).text.indexOf('Helper') + 1);

      const prepared = await waitForEventually(
        'Prepare Rename for Helper',
        async () => vscode.commands.executeCommand<unknown>(
          '_executePrepareRename',
          uri,
          position,
        ),
        (result) => JSON.stringify(result).includes('Helper'),
      );
      assert.ok(prepared, 'expected Prepare Rename result');

      const edit = await waitForEventually(
        'Workspace Rename edits for Helper',
        async () => vscode.commands.executeCommand<unknown>(
          '_executeDocumentRenameProvider',
          uri,
          position,
          'RenamedHelper',
        ),
        (result) => {
          const serialized = JSON.stringify(result);
          return serialized.includes('RenamedHelper')
            && serialized.includes('Lib.hlsl')
            && serialized.includes('Use1.hlsl')
            && serialized.includes('Use2.hlsl');
        },
      );
      const serialized = JSON.stringify(edit);
      assert.ok(!serialized.includes('rejectReason'), serialized);
      assert.ok(
        serialized.match(/RenamedHelper/g)?.length === 3,
        `expected exactly three rename edits, got ${serialized}`,
      );
    });
  });

  test('uses the current unsaved document attempt', async () => {
    const root = fixturePath('refs-project');
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(path.join(root, 'Assets', 'Shaders', 'Lib.hlsl'));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);
      const inserted = '\nfloat4 LiveHelper() { return LiveHelper(); }\n';
      const applied = await editor.edit((builder) => builder.insert(
        document.positionAt(document.getText().length),
        inserted,
      ));
      assert.ok(applied, 'expected unsaved edit to apply');
      const line = document.lineCount - 2;
      const position = new vscode.Position(
        line,
        document.lineAt(line).text.lastIndexOf('LiveHelper') + 1,
      );

      try {
        const edit = await waitForEventually(
          'Workspace Rename edits from unsaved overlay',
          async () => vscode.commands.executeCommand<unknown>(
            '_executeDocumentRenameProvider',
            uri,
            position,
            'RenamedLiveHelper',
          ),
          (result) => JSON.stringify(result).match(/RenamedLiveHelper/g)?.length === 2,
        );
        assert.strictEqual(JSON.stringify(edit).match(/RenamedLiveHelper/g)?.length, 2);
      } finally {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    });
  });
});
