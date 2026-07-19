import {
  ProgressLocation,
  commands,
  window,
  workspace,
  type Disposable,
  type QuickPickItem,
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  PORTABILITY_REPORT_REQUEST,
  PORTABILITY_TARGETS_REQUEST,
  SHOW_PORTABILITY_REPORT_COMMAND,
  type PortabilityReport,
  type PortabilityTarget,
  type PortabilityTargetsResult,
} from '@unity-shader-nav/shared';
import { formatPortabilityReportMarkdown } from './portabilityReport';

interface TargetPick extends QuickPickItem {
  readonly target: PortabilityTarget;
}

export function registerPortabilityReportCommand(
  client: LanguageClient,
  reportError: (message: string, error: unknown) => void,
): Disposable {
  return commands.registerCommand(SHOW_PORTABILITY_REPORT_COMMAND, async () => {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'shaderlab') {
      await window.showWarningMessage(
        'Open a ShaderLab .shader document to generate a portability report.',
      );
      return;
    }
    const uri = editor.document.uri.toString();
    try {
      const available = await client.sendRequest<PortabilityTargetsResult>(
        PORTABILITY_TARGETS_REQUEST,
        { textDocument: { uri } },
      );
      const target = await window.showQuickPick<TargetPick>(
        available.targets.map((option) => ({
          label: option.label,
          detail: option.detail,
          target: option.target,
        })),
        {
          title: 'Custom Shader portability target',
          placeHolder: 'Select a render pipeline or compiler graphics profile',
          matchOnDetail: true,
        },
      );
      if (!target) return;

      const report = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Generating portability report for ${target.label}`,
        },
        () => client.sendRequest<PortabilityReport | null>(
          PORTABILITY_REPORT_REQUEST,
          { textDocument: { uri }, target: target.target },
        ),
      );
      if (!report) {
        await window.showWarningMessage(
          'The current document does not belong to a ready indexed revision.',
        );
        return;
      }
      const document = await workspace.openTextDocument({
        language: 'markdown',
        content: formatPortabilityReportMarkdown(report),
      });
      await window.showTextDocument(document, { preview: true, preserveFocus: false });
    } catch (error) {
      reportError('Failed to generate Shader portability report', error);
    }
  });
}
