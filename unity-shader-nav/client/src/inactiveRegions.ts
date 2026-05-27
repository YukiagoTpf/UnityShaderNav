import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  INACTIVE_REGIONS_REQUEST,
  type InactiveRegionsParams,
  type InactiveRegionsResult,
} from '@unity-shader-nav/shared';

const SUPPORTED_LANGUAGES = new Set(['shaderlab', 'hlsl']);
const DEBOUNCE_MS = 300;

function getConfig() {
  return vscode.workspace.getConfiguration('unityShaderNav');
}

function isEnabled(): boolean {
  return getConfig().get<boolean>('dimInactiveBranches.enabled', true);
}

function getOpacity(): number {
  return getConfig().get<number>('dimInactiveBranches.opacity', 0.55);
}

function createDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    // `opacity` is injected as inline CSS; `!important` is required so it wins
    // against VS Code's own token/theme styles. Do NOT set `color` (it would
    // replace the text color and fight semantic tokens).
    opacity: `${getOpacity()} !important`,
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

export function setupInactiveRegions(client: LanguageClient, context: vscode.ExtensionContext): void {
  let decorationType = createDecorationType();
  // Per-URI latest requested document version, so only the newest in-flight
  // request lands (review P2 stale-guard).
  const latestRequested = new Map<string, number>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  context.subscriptions.push({ dispose: () => decorationType.dispose() });

  function refresh(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;

    const { document } = editor;
    const uri = document.uri.toString();

    if (!SUPPORTED_LANGUAGES.has(document.languageId) || !isEnabled()) {
      editor.setDecorations(decorationType, []);
      latestRequested.delete(uri);
      return;
    }

    const requestedVersion = document.version;
    latestRequested.set(uri, requestedVersion);

    const params: InactiveRegionsParams = {
      textDocument: { uri, version: requestedVersion },
    };

    client.sendRequest<InactiveRegionsResult>(INACTIVE_REGIONS_REQUEST, params).then(
      (result) => {
        if (!result) return;
        // Drop stale responses: a newer request superseded this one, the doc
        // moved on, or the server echoed a different version.
        if (latestRequested.get(uri) !== requestedVersion) return;
        if (editor.document.version !== requestedVersion) return;
        if (result.version !== requestedVersion) return;

        const ranges = result.regions.map(
          (region) =>
            new vscode.Range(
              region.range.start.line,
              region.range.start.character,
              region.range.end.line,
              region.range.end.character,
            ),
        );
        editor.setDecorations(decorationType, ranges);
      },
      (err) => {
        console.error('[UnityShaderNav] inactiveRegions request failed', err);
      },
    );
  }

  function refreshVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      refresh(editor);
    }
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => refresh(editor)),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) refresh(editor);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const uri = event.document.uri.toString();
      const existing = debounceTimers.get(uri);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        uri,
        setTimeout(() => {
          debounceTimers.delete(uri);
          for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === uri) refresh(editor);
          }
        }, DEBOUNCE_MS),
      );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('unityShaderNav.dimInactiveBranches')) return;
      // Recreate the decoration type so an opacity change takes effect.
      const old = decorationType;
      decorationType = createDecorationType();
      old.dispose();
      refreshVisible();
    }),
    {
      dispose: () => {
        for (const timer of debounceTimers.values()) clearTimeout(timer);
        debounceTimers.clear();
      },
    },
  );

  refresh(vscode.window.activeTextEditor);
}
