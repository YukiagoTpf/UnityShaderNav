import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  INACTIVE_REGIONS_REQUEST,
  type InactiveRegionsParams,
  type InactiveRegionsResult,
} from '@unity-shader-nav/shared';

const SUPPORTED_LANGUAGES = new Set(['shaderlab', 'hlsl']);
const DEBOUNCE_MS = 300;

function getConfig(uri: vscode.Uri | undefined) {
  return vscode.workspace.getConfiguration('unityShaderNav', uri);
}

function isEnabled(uri: vscode.Uri | undefined): boolean {
  return getConfig(uri).get<boolean>('dimInactiveBranches.enabled', true);
}

function getOpacity(uri: vscode.Uri | undefined): number {
  return getConfig(uri).get<number>('dimInactiveBranches.opacity', 0.55);
}

function createDecorationType(opacity: number): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    // `opacity` is injected as inline CSS; `!important` is required so it wins
    // against VS Code's own token/theme styles. Do NOT set `color` (it would
    // replace the text color and fight semantic tokens).
    opacity: `${opacity} !important`,
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

export function setupInactiveRegions(client: LanguageClient, context: vscode.ExtensionContext): void {
  // Per-URI decoration types and the opacity they were created with. Resource-
  // scoped config means two open files can resolve different opacity values.
  const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();
  const decorationOpacities = new Map<string, number>();
  // Per-URI latest requested document version, so only the newest in-flight
  // request lands (review P2 stale-guard).
  const latestRequested = new Map<string, number>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function getOrCreateDecoration(uri: vscode.Uri): vscode.TextEditorDecorationType {
    const key = uri.toString();
    const opacity = getOpacity(uri);
    const existing = decorationTypes.get(key);
    const existingOpacity = decorationOpacities.get(key);
    if (existing && existingOpacity === opacity) return existing;
    if (existing) existing.dispose();
    const created = createDecorationType(opacity);
    decorationTypes.set(key, created);
    decorationOpacities.set(key, opacity);
    return created;
  }

  function refresh(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;

    const { document } = editor;
    const uri = document.uri.toString();

    if (!SUPPORTED_LANGUAGES.has(document.languageId) || !isEnabled(document.uri)) {
      const existing = decorationTypes.get(uri);
      if (existing) editor.setDecorations(existing, []);
      latestRequested.delete(uri);
      return;
    }

    const decorationType = getOrCreateDecoration(document.uri);

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
      // Re-resolve opacity for each visible editor's URI. If it changed for a
      // cached entry, dispose it so the next refresh recreates lazily.
      const seen = new Set<string>();
      for (const editor of vscode.window.visibleTextEditors) {
        const key = editor.document.uri.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!decorationTypes.has(key)) continue;
        const newOpacity = getOpacity(editor.document.uri);
        if (decorationOpacities.get(key) !== newOpacity) {
          decorationTypes.get(key)?.dispose();
          decorationTypes.delete(key);
          decorationOpacities.delete(key);
        }
      }
      refreshVisible();
    }),
    {
      dispose: () => {
        for (const timer of debounceTimers.values()) clearTimeout(timer);
        debounceTimers.clear();
        for (const decoration of decorationTypes.values()) decoration.dispose();
        decorationTypes.clear();
        decorationOpacities.clear();
      },
    },
  );

  refresh(vscode.window.activeTextEditor);
}
