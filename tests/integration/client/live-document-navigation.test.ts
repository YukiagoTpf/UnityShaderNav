import * as assert from 'node:assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  closeEditorsForFolder,
  waitForEventually,
  withWorkspaceFolder,
} from './helpers/workspace';

function targetUri(location: vscode.LocationLink | vscode.Location): vscode.Uri {
  return (location as vscode.LocationLink).targetUri ?? (location as vscode.Location).uri;
}

function positionOf(text: string, token: string, occurrence = 0): vscode.Position {
  let offset = 0;
  for (let index = 0; index <= occurrence; index++) {
    offset = text.indexOf(token, offset);
    assert.ok(offset >= 0, `expected text to contain ${token}`);
    if (index < occurrence) offset += token.length;
  }
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return new vscode.Position(lines.length - 1, lines.at(-1)!.length + 2);
}

suite('Live document navigation', () => {
  test('unsaved Definition/References update and revert-and-close returns to disk navigation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usn-live-navigation-'));
    const shaders = path.join(root, 'Assets', 'Shaders');
    const targetPath = path.join(shaders, 'Target.hlsl');
    const callerPath = path.join(shaders, 'Caller.hlsl');
    const savedTarget = 'float4 SavedTarget() { return 0; }\n';
    const unsavedTarget = [
      'float4 LiveTarget() { return 0; }',
      'float4 LiveCaller() { return LiveTarget(); }',
    ].join('\n');
    const callerText = [
      '#include "Target.hlsl"',
      'float4 Caller() { return SavedTarget(); }',
    ].join('\n');

    await fs.mkdir(shaders, { recursive: true });
    await fs.mkdir(path.join(root, 'ProjectSettings'), { recursive: true });
    await fs.mkdir(path.join(root, 'Packages'), { recursive: true });
    await fs.writeFile(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n');
    await fs.writeFile(path.join(root, 'Packages', 'packages-lock.json'), '{"dependencies":{}}\n');
    await fs.writeFile(targetPath, savedTarget);
    await fs.writeFile(callerPath, callerText);

    try {
      await withWorkspaceFolder(root, async () => {
        try {
          const target = vscode.Uri.file(targetPath);
          const targetDocument = await vscode.workspace.openTextDocument(target);
          await vscode.window.showTextDocument(targetDocument, { preview: false });
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            target,
            new vscode.Range(
              new vscode.Position(0, 0),
              targetDocument.positionAt(targetDocument.getText().length),
            ),
            unsavedTarget,
          );
          assert.ok(await vscode.workspace.applyEdit(edit), 'expected unsaved target edit to apply');

          const liveDefinitions = await waitForEventually(
            'unsaved LiveTarget definition',
            () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
              'vscode.executeDefinitionProvider',
              target,
              positionOf(unsavedTarget, 'LiveTarget', 1),
            ),
            (locations) => (locations?.length ?? 0) === 1
              && targetUri(locations![0]).fsPath === targetPath,
          );
          assert.equal(liveDefinitions?.length, 1);

          const liveReferences = await waitForEventually(
            'unsaved LiveTarget references',
            () => vscode.commands.executeCommand<vscode.Location[]>(
              'vscode.executeReferenceProvider',
              target,
              positionOf(unsavedTarget, 'LiveTarget'),
            ),
            (locations) => (locations?.filter((location) => location.uri.fsPath === targetPath).length ?? 0) >= 2,
          );
          assert.ok(liveReferences && liveReferences.length >= 2);

          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

          const caller = vscode.Uri.file(callerPath);
          const callerDocument = await vscode.workspace.openTextDocument(caller);
          await vscode.window.showTextDocument(callerDocument, { preview: false });
          const savedPosition = positionOf(callerText, 'SavedTarget');

          const savedDefinitions = await waitForEventually(
            'SavedTarget disk definition after close',
            () => vscode.commands.executeCommand<Array<vscode.LocationLink | vscode.Location>>(
              'vscode.executeDefinitionProvider',
              caller,
              savedPosition,
            ),
            (locations) => (locations?.length ?? 0) === 1
              && targetUri(locations![0]).fsPath === targetPath,
          );
          assert.equal(savedDefinitions?.length, 1);

          const savedReferences = await waitForEventually(
            'SavedTarget disk references after close',
            () => vscode.commands.executeCommand<vscode.Location[]>(
              'vscode.executeReferenceProvider',
              caller,
              savedPosition,
            ),
            (locations) => !!locations
              && locations.some((location) => location.uri.fsPath === targetPath)
              && locations.some((location) => location.uri.fsPath === callerPath),
          );
          assert.ok(savedReferences && savedReferences.length >= 2);
        } finally {
          await closeEditorsForFolder(root);
        }
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
