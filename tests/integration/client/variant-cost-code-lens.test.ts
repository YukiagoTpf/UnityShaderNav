import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OPEN_VARIANT_COST_DOCUMENTATION_COMMAND } from '@unity-shader-nav/shared';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(__dirname, '../../../integration/client/fixtures/authoring-assistance', ...segments);
}

function programTitle(lenses: readonly vscode.CodeLens[]): string | undefined {
  return lenses
    .map((lens) => lens.command?.title)
    .find((title) => title?.startsWith('Declared/static program upper bound:'));
}

suite('Declared Variant cost CodeLens', () => {
  test('reports the current unsaved program product and documentation action', async () => {
    await withWorkspaceFolder(fixturePath(), async () => {
      const uri = vscode.Uri.file(fixturePath('Assets', 'VariantCost.compute'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });

      const initial = await waitForEventually(
        'initial declared Variant cost CodeLens',
        () => vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          uri,
        ),
        (lenses) => programTitle(lenses ?? [])?.includes('6 variants') === true,
      );
      assert.ok(initial?.every((lens) => (
        lens.command?.command === OPEN_VARIANT_COST_DOCUMENTATION_COMMAND
      )));

      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(
          new vscode.Position(1, 0),
          new vscode.Position(1, document.lineAt(1).text.length),
        ),
        '#pragma shader_feature _ FOG_ON RAIN_ON',
      );
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

      const updated = await waitForEventually(
        'live declared Variant cost CodeLens',
        () => vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          uri,
        ),
        (lenses) => programTitle(lenses ?? [])?.includes('9 variants') === true,
      );
      assert.ok(programTitle(updated)?.includes('9 variants'));
    });
  });
});
