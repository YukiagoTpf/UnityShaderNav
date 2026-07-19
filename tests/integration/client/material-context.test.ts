import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MaterialContextResult } from '@unity-shader-nav/shared';
import {
  closeEditorsForFolder,
  withWorkspaceFolder,
} from './helpers/workspace';

const SHOW_MATERIAL_CONTEXT_COMMAND = 'unityShaderNav.showMaterialContext';

function fixture(...segments: string[]): string {
  return path.resolve(
    __dirname,
    '../../../integration/client/fixtures/diagnostics',
    ...segments,
  );
}

suite('Selected Material Context client', () => {
  test('keeps Adapter absence explicit through the production command path', async () => {
    const root = fixture();
    await withWorkspaceFolder(root, async () => {
      try {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(fixture('Assets/EntryPoints.shader')),
        );
        await vscode.window.showTextDocument(document, { preview: false });

        const result = await vscode.commands.executeCommand<MaterialContextResult>(
          SHOW_MATERIAL_CONTEXT_COMMAND,
          { inspect: true },
        );
        assert.deepStrictEqual(result, {
          status: 'unavailable',
          reason: 'no-adapter',
        });
      } finally {
        await closeEditorsForFolder(root);
      }
    });
  });
});
