import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  INACTIVE_REGIONS_REQUEST,
  normalizeSettingValue,
  type InactiveRegionsResult,
} from '@unity-shader-nav/shared';
import {
  InactiveRegionController,
  type InactiveRegionDocument,
} from './inactiveRegionController';
import type { ClientErrorReporter } from './output';

type DebounceTimer = ReturnType<typeof setTimeout>;

function getConfig(uri: vscode.Uri | undefined) {
  return vscode.workspace.getConfiguration('unityShaderNav', uri);
}

function isEnabled(uri: vscode.Uri | undefined): boolean {
  return normalizeSettingValue(
    'dimInactiveBranches.enabled',
    getConfig(uri).get<unknown>('dimInactiveBranches.enabled'),
  );
}

function getOpacity(uri: vscode.Uri | undefined): number {
  return normalizeSettingValue(
    'dimInactiveBranches.opacity',
    getConfig(uri).get<unknown>('dimInactiveBranches.opacity'),
  );
}

function describeDocument(document: vscode.TextDocument): InactiveRegionDocument {
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    version: document.version,
  };
}

function createDecorationOptions(opacity: number): vscode.DecorationRenderOptions {
  return {
    // `opacity` is injected as inline CSS; `!important` is required so it wins
    // against VS Code's token/theme styles. Do not set `color`: that would
    // replace the semantic-token foreground instead of dimming it.
    opacity: `${opacity} !important`,
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  };
}

function createDecorations(opacity: number): {
  inactive: vscode.TextEditorDecorationType;
  variant: vscode.TextEditorDecorationType;
} {
  const base = createDecorationOptions(opacity);
  return {
    inactive: vscode.window.createTextEditorDecorationType(base),
    variant: vscode.window.createTextEditorDecorationType({
      ...base,
      // A registry-backed color adapts to the active theme and marks a branch
      // as variant-dependent without replacing its semantic foreground.
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    }),
  };
}

export function setupInactiveRegions(
  client: LanguageClient,
  context: vscode.ExtensionContext,
  reportError: ClientErrorReporter,
): void {
  const controller = new InactiveRegionController<
    vscode.TextEditor,
    vscode.Range,
    DebounceTimer,
    vscode.TextEditorDecorationType
  >({
    describe: ({ document }) => describeDocument(document),
    visibleEditors: () => vscode.window.visibleTextEditors,
    isEnabled: ({ uri }) => isEnabled(vscode.Uri.parse(uri)),
    opacity: ({ uri }) => getOpacity(vscode.Uri.parse(uri)),
    createDecorations,
    setDecorations: (editor, decoration, ranges) => {
      editor.setDecorations(decoration, ranges);
    },
    toRange: (range) => new vscode.Range(
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
    ),
    request: (params) => client.sendRequest<InactiveRegionsResult>(
      INACTIVE_REGIONS_REQUEST,
      params,
    ),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (timer) => clearTimeout(timer),
    reportError: (error) => reportError('Failed to refresh inactive regions', error),
  });

  const refreshVisibleEditors = (): void => {
    controller.visibleEditorsChanged(vscode.window.visibleTextEditors);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refreshVisibleEditors),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      controller.visibleEditorsChanged(editors);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      controller.documentChanged(describeDocument(document));
    }),
    vscode.workspace.onDidCloseTextDocument(({ uri }) => {
      controller.documentClosed(uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('unityShaderNav.dimInactiveBranches')) return;
      controller.configurationChanged();
    }),
    { dispose: () => controller.dispose() },
  );

  refreshVisibleEditors();
}
