import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { waitForEventually, withWorkspaceFolder } from './helpers/workspace';

function fixturePath(...segments: string[]): string {
  return path.resolve(
    __dirname,
    '../../../integration/client/fixtures/shaderlab-names',
    ...segments,
  );
}

suite('ShaderLab names', () => {
  test('routes Shader and Pass navigation and Rename through the Extension Host', async () => {
    const root = fixturePath();
    await withWorkspaceFolder(root, async () => {
      const consumerUri = vscode.Uri.file(fixturePath('Assets', 'Consumer.shader'));
      const libraryUri = vscode.Uri.file(fixturePath('Assets', 'Library.shader'));
      const consumer = await vscode.workspace.openTextDocument(consumerUri);
      await vscode.window.showTextDocument(consumer);
      const shaderPosition = new vscode.Position(
        2,
        consumer.lineAt(2).text.indexOf('Integration/Library') + 1,
      );
      const passPosition = new vscode.Position(
        5,
        consumer.lineAt(5).text.indexOf('FORWARDLIT') + 1,
      );

      const shaderDefinitions = await waitForEventually(
        'ShaderLab Shader definition',
        async () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
          'vscode.executeDefinitionProvider',
          consumerUri,
          shaderPosition,
        ),
        (links) => links?.some((link) => (
          ((link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri)
            .fsPath === libraryUri.fsPath
        )) ?? false,
      );
      assert.ok(shaderDefinitions?.length, 'expected Shader definition');

      const passDefinitions = await waitForEventually(
        'ShaderLab Pass definition',
        async () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
          'vscode.executeDefinitionProvider',
          consumerUri,
          passPosition,
        ),
        (links) => links?.some((link) => (
          ((link as vscode.LocationLink).targetUri ?? (link as vscode.Location).uri)
            .fsPath === libraryUri.fsPath
        )) ?? false,
      );
      assert.ok(passDefinitions?.length, 'expected Pass definition');

      const edit = await waitForEventually(
        'ShaderLab Pass rename',
        async () => vscode.commands.executeCommand<unknown>(
          '_executeDocumentRenameProvider',
          consumerUri,
          passPosition,
          'DepthOnly',
        ),
        (result) => {
          const serialized = JSON.stringify(result);
          return serialized.includes('DepthOnly') && serialized.includes('DEPTHONLY');
        },
      );
      const serialized = JSON.stringify(edit);
      assert.ok(serialized.includes('Library.shader'), serialized);
      assert.ok(serialized.includes('Consumer.shader'), serialized);
    });
  });
});
