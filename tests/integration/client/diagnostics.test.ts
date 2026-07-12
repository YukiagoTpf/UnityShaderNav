import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(
    __dirname,
    '../../../integration/client/fixtures/diagnostics',
    ...segments,
  );
}

function entryPointDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((diagnostic) => (
    diagnostic.source === 'UnityShaderNav'
    && diagnostic.code === 'unresolved-entry-point'
  ));
}

suite('Entry-point diagnostics', () => {
  test('publishes, fixes, and restores Problems for the live document', async () => {
    const root = fixturePath();
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(fixturePath('Assets', 'EntryPoints.shader'));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document);

      const initial = await waitForEventually(
        'one unresolved entry-point diagnostic',
        async () => entryPointDiagnostics(uri),
        (diagnostics) => diagnostics.length === 1
          && diagnostics[0].message.includes('MissingVertex'),
      );
      assert.strictEqual(initial.length, 1);

      const endLine = document.getText().split(/\r?\n/)
        .findIndex((line) => line.trim() === 'ENDHLSL');
      assert.ok(endLine > 0, 'expected ENDHLSL in diagnostics fixture');
      const inserted = '            float4 MissingVertex() : SV_POSITION { return 0; }\n';
      assert.ok(await editor.edit((builder) => {
        builder.insert(new vscode.Position(endLine, 0), inserted);
      }));

      await waitForEventually(
        'entry-point diagnostic to clear after live fix',
        async () => entryPointDiagnostics(uri),
        (diagnostics) => diagnostics.length === 0,
      );

      assert.ok(await editor.edit((builder) => {
        builder.delete(new vscode.Range(
          new vscode.Position(endLine, 0),
          new vscode.Position(endLine + 1, 0),
        ));
      }));
      await waitForEventually(
        'entry-point diagnostic to return after removing the live fix',
        async () => entryPointDiagnostics(uri),
        (diagnostics) => diagnostics.length === 1,
      );
    });
  });
});
