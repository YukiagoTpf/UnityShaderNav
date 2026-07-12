import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(
    __dirname,
    '../../../integration/client/fixtures/srp-contracts',
    ...segments,
  );
}

function contractDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((diagnostic) => (
    diagnostic.source === 'UnityShaderNav'
    && diagnostic.code === 'srp-batcher-property'
  ));
}

suite('SRP Batcher contracts', () => {
  test('offers and applies a safe UnityPerMaterial Quick Fix', async () => {
    const root = fixturePath();
    await withWorkspaceFolder(root, async () => {
      const uri = vscode.Uri.file(fixturePath('Assets', 'Material.shader'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const propertyLine = document.getText().split(/\r?\n/)
        .findIndex((line) => line.includes('_Smoothness ('));
      assert.ok(propertyLine >= 0, 'expected _Smoothness property');
      const start = document.lineAt(propertyLine).text.indexOf('_Smoothness');
      const range = new vscode.Range(
        new vscode.Position(propertyLine, start),
        new vscode.Position(propertyLine, start + '_Smoothness'.length),
      );

      await waitForEventually(
        'missing UnityPerMaterial property diagnostic',
        async () => contractDiagnostics(uri),
        (diagnostics) => diagnostics.length === 1,
      );

      const actions = await waitForEventually(
        'safe UnityPerMaterial Quick Fix',
        async () => vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          uri,
          range,
          vscode.CodeActionKind.QuickFix.value,
        ),
        (items) => items?.some((action) => (
          action.title === 'Add _Smoothness to UnityPerMaterial'
          && !!action.edit
        )) ?? false,
      );
      const action = actions.find((item) => item.title === 'Add _Smoothness to UnityPerMaterial');
      assert.ok(action?.edit, 'expected preferred SRP Batcher edit');
      assert.ok(await vscode.workspace.applyEdit(action.edit), 'expected Quick Fix edit to apply');

      await waitForEventually(
        'SRP Batcher diagnostic to clear after Quick Fix',
        async () => contractDiagnostics(uri),
        (diagnostics) => diagnostics.length === 0,
      );

      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
  });
});
