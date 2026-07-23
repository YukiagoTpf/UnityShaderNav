import {
  Position,
  Range,
  TextEdit,
  Uri,
  WorkspaceEdit,
  commands,
  window,
  workspace,
  type Disposable,
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  PREVIEW_PROPERTY_RENAME_COMMAND,
  PROPERTY_RENAME_BEGIN_REQUEST,
  PROPERTY_RENAME_FINISH_REQUEST,
  PROPERTY_RENAME_PREVIEW_REQUEST,
  type PropertyRenameBeginResult,
  type PropertyRenameFinishResult,
  type PropertyRenameParams,
  type PropertyRenamePreview,
  type PropertyRenamePreviewItem,
  type PropertyRenamePreviewResult,
  type PropertyRenameSourceEdit,
} from '@unity-shader-nav/shared';

function locationLabel(item: PropertyRenamePreviewItem): string {
  if (item.kind === 'material-asset-edit') {
    return `\`${item.path}\` (GUID \`${item.guid}\`)`;
  }
  return `\`${item.uri}:${item.range.start.line + 1}:${item.range.start.character + 1}\``;
}

export function formatPropertyRenamePreview(
  preview: PropertyRenamePreview,
): string {
  const lines = [
    '# Safe Shader Property Rename',
    '',
    `\`${preview.oldName}\` → \`${preview.newName}\``,
    '',
  ];
  for (const group of preview.groups) {
    lines.push(`## ${group.label} (${group.items.length})`, '');
    for (const item of group.items) {
      lines.push(`- ${locationLabel(item)}`);
    }
    lines.push('');
  }
  if (preview.blockers.length > 0) {
    lines.push(`## Blockers (${preview.blockers.length})`, '');
    for (const blocker of preview.blockers) {
      lines.push(`- **${blocker.code}**: ${blocker.message}`);
    }
    lines.push('');
  }
  if (preview.manualFollowUps.length > 0) {
    lines.push(`## Manual follow-up (${preview.manualFollowUps.length})`, '');
    for (const followUp of preview.manualFollowUps) {
      lines.push(`- ${followUp.path ? `\`${followUp.path}\`: ` : ''}${followUp.message}`);
    }
    lines.push('');
  }
  lines.push(
    preview.canApply
      ? 'The source edits and Adapter asset transaction can be applied together.'
      : 'Apply is disabled until every blocker is resolved.',
    '',
  );
  return lines.join('\n');
}

function vscodeRange(edit: PropertyRenameSourceEdit): Range {
  return new Range(
    edit.range.start.line,
    edit.range.start.character,
    edit.range.end.line,
    edit.range.end.character,
  );
}

function forwardWorkspaceEdit(
  edits: readonly PropertyRenameSourceEdit[],
): WorkspaceEdit {
  const result = new WorkspaceEdit();
  for (const edit of edits) {
    result.replace(Uri.parse(edit.uri, true), vscodeRange(edit), edit.newText);
  }
  return result;
}

function rollbackWorkspaceEdit(
  edits: readonly PropertyRenameSourceEdit[],
): WorkspaceEdit {
  const result = new WorkspaceEdit();
  const byUri = new Map<string, PropertyRenameSourceEdit[]>();
  for (const edit of edits) {
    const grouped = byUri.get(edit.uri);
    if (grouped) grouped.push(edit);
    else byUri.set(edit.uri, [edit]);
  }
  for (const [uri, sourceEdits] of byUri) {
    const ordered = [...sourceEdits].sort((left, right) => (
      left.range.start.line - right.range.start.line
      || left.range.start.character - right.range.start.character
    ));
    const lineDelta = new Map<number, number>();
    const rollbackEdits: TextEdit[] = [];
    for (const edit of ordered) {
      const line = edit.range.start.line;
      const startCharacter = edit.range.start.character + (lineDelta.get(line) ?? 0);
      const range = new Range(
        new Position(line, startCharacter),
        new Position(line, startCharacter + edit.newText.length),
      );
      rollbackEdits.push(TextEdit.replace(range, edit.oldText));
      lineDelta.set(
        line,
        (lineDelta.get(line) ?? 0) + edit.newText.length - edit.oldText.length,
      );
    }
    result.set(Uri.parse(uri, true), rollbackEdits);
  }
  return result;
}

async function sourcesStillMatch(
  edits: readonly PropertyRenameSourceEdit[],
): Promise<boolean> {
  const documents = new Map<string, Awaited<ReturnType<typeof workspace.openTextDocument>>>();
  for (const edit of edits) {
    let document = documents.get(edit.uri);
    if (!document) {
      document = await workspace.openTextDocument(Uri.parse(edit.uri, true));
      documents.set(edit.uri, document);
    }
    if (document.getText(vscodeRange(edit)) !== edit.oldText) return false;
  }
  return true;
}

export function registerPropertyRenameCommand(
  client: LanguageClient,
  reportError: (message: string, error: unknown) => void,
): Disposable {
  return commands.registerCommand(PREVIEW_PROPERTY_RENAME_COMMAND, async () => {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'shaderlab') {
      await window.showWarningMessage(
        'Open a ShaderLab Property before previewing a safe cross-asset Rename.',
      );
      return;
    }
    const newName = await window.showInputBox({
      title: 'Safe Shader Property Rename',
      prompt: 'New Shader Property identifier',
      validateInput: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
        ? undefined
        : 'Use a valid ShaderLab/HLSL identifier.',
    });
    if (!newName) return;

    const uri = editor.document.uri.toString();
    const params: PropertyRenameParams = {
      textDocument: { uri },
      position: {
        line: editor.selection.active.line,
        character: editor.selection.active.character,
      },
      newName,
    };
    let transactionId: string | undefined;
    let appliedEdits: readonly PropertyRenameSourceEdit[] | undefined;
    try {
      const previewResult = await client.sendRequest<PropertyRenamePreviewResult>(
        PROPERTY_RENAME_PREVIEW_REQUEST,
        params,
      );
      if (previewResult.status === 'failure') {
        await window.showWarningMessage(previewResult.message);
        return;
      }
      const previewDocument = await workspace.openTextDocument({
        language: 'markdown',
        content: formatPropertyRenamePreview(previewResult.preview),
      });
      await window.showTextDocument(previewDocument, {
        preview: true,
        preserveFocus: false,
      });
      if (!previewResult.preview.canApply) {
        await window.showWarningMessage(
          `Safe Rename is blocked by ${previewResult.preview.blockers.length} unresolved item(s).`,
        );
        return;
      }
      const confirmation = await window.showInformationMessage(
        `Apply ${previewResult.preview.groups.reduce(
          (count, group) => count + group.items.length,
          0,
        )} reviewed Shader, C#, and Material changes?`,
        { modal: true },
        'Apply Rename',
      );
      if (confirmation !== 'Apply Rename') return;

      const begin = await client.sendRequest<PropertyRenameBeginResult>(
        PROPERTY_RENAME_BEGIN_REQUEST,
        { ...params, previewId: previewResult.preview.previewId },
      );
      if (begin.status !== 'ready') {
        await window.showWarningMessage(begin.message);
        return;
      }
      transactionId = begin.transactionId;
      if (!await sourcesStillMatch(begin.edits)) {
        await client.sendRequest<PropertyRenameFinishResult>(
          PROPERTY_RENAME_FINISH_REQUEST,
          { textDocument: { uri }, transactionId, sourceApplied: false },
        );
        transactionId = undefined;
        await window.showWarningMessage(
          'A source changed after preparation. The asset transaction was rolled back.',
        );
        return;
      }
      const sourceApplied = await workspace.applyEdit(forwardWorkspaceEdit(begin.edits));
      if (!sourceApplied) {
        await client.sendRequest<PropertyRenameFinishResult>(
          PROPERTY_RENAME_FINISH_REQUEST,
          { textDocument: { uri }, transactionId, sourceApplied: false },
        );
        transactionId = undefined;
        await window.showWarningMessage(
          'VS Code rejected the source edits. The asset transaction was rolled back.',
        );
        return;
      }
      appliedEdits = begin.edits;

      const finished = await client.sendRequest<PropertyRenameFinishResult>(
        PROPERTY_RENAME_FINISH_REQUEST,
        { textDocument: { uri }, transactionId, sourceApplied: true },
      );
      transactionId = undefined;
      if (finished.status === 'committed') {
        appliedEdits = undefined;
        await window.showInformationMessage(
          `Renamed ${previewResult.preview.oldName} to ${newName}.`,
        );
        return;
      }
      const sourceRolledBack = await workspace.applyEdit(
        rollbackWorkspaceEdit(begin.edits),
      );
      appliedEdits = undefined;
      const failureMessage = finished.status === 'failed'
        ? finished.message
        : 'The Adapter rolled back instead of committing the Material transaction.';
      await window.showErrorMessage(
        sourceRolledBack
          ? `${failureMessage} Source edits were rolled back.`
          : `${failureMessage} Source rollback also failed; review the previewed files.`,
      );
    } catch (error) {
      if (transactionId && appliedEdits) {
        try {
          const retried = await client.sendRequest<PropertyRenameFinishResult>(
            PROPERTY_RENAME_FINISH_REQUEST,
            { textDocument: { uri }, transactionId, sourceApplied: true },
          );
          transactionId = undefined;
          if (retried.status === 'committed') {
            appliedEdits = undefined;
            await window.showInformationMessage(
              `Renamed ${newName}; the transaction confirmation succeeded on retry.`,
            );
            return;
          }
          const rolledBack = await workspace.applyEdit(
            rollbackWorkspaceEdit(appliedEdits),
          );
          appliedEdits = undefined;
          await window.showErrorMessage(
            rolledBack
              ? 'The asset transaction failed; source edits were rolled back.'
              : 'The asset transaction and source rollback failed; review the previewed files.',
          );
        } catch (confirmationError) {
          reportError(
            'Property Rename commit status is unknown; source was left unchanged to avoid contradicting a possible asset commit',
            confirmationError,
          );
          await window.showErrorMessage(
            'Rename commit status is unknown after a connection failure. Source edits were kept; reconnect and inspect the previewed assets before retrying.',
          );
          return;
        }
      } else if (transactionId) {
        try {
          await client.sendRequest<PropertyRenameFinishResult>(
            PROPERTY_RENAME_FINISH_REQUEST,
            { textDocument: { uri }, transactionId, sourceApplied: false },
          );
        } catch {
          // Report the primary failure below.
        }
      }
      reportError('Safe cross-asset Property Rename failed', error);
    }
  });
}
