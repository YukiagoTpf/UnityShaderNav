import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  GET_VARIANT_KEYWORDS_REQUEST,
  VARIANT_CONTEXT_CHANGED_NOTIFICATION,
  VARIANT_CONTEXT_REQUEST,
  type GetVariantKeywordsParams,
  type GetVariantKeywordsResult,
  type VariantContext,
  type VariantContextResult,
} from '@unity-shader-nav/shared';

const SUPPORTED_LANGUAGES = new Set(['shaderlab', 'hlsl']);

export interface VariantContextPicker {
  dispose(): void;
}

/**
 * Build the status-bar entry + QuickPick that let the user toggle the active
 * variant keywords for the current shader document. The chosen set is sent to
 * the server as a VariantContext; dimming and navigation then prefer the
 * active branch.
 */
export function createVariantContextPicker(
  client: LanguageClient,
  refreshDimming: () => void,
): VariantContextPicker {
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90,
  );
  statusItem.name = 'UnityShaderNav Variant Context';
  statusItem.command = 'unityShaderNav.pickVariantContext';

  /** active keyword sets keyed by document URI (in-memory, session-only) */
  const activeByUri = new Map<string, Set<string>>();

  const updateStatus = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !SUPPORTED_LANGUAGES.has(editor.document.languageId)) {
      statusItem.hide();
      return;
    }
    const docUri = editor.document.uri.toString();
    const active = activeByUri.get(docUri);
    if (active && active.size > 0) {
      statusItem.text = `$(symbol-keyword) Variants: ${active.size}`;
      statusItem.tooltip = `Active variant keywords: ${[...active].sort().join(', ')}`;
    } else {
      statusItem.text = `$(symbol-keyword) Variants: off`;
      statusItem.tooltip = 'No variant context selected (conservative — all branches valid)';
    }
    statusItem.show();
  };

  const sendContext = (uri: string, active: Set<string> | null): void => {
    // Send activeKeywords as an array over JSON-RPC (Set serializes to {}).
    const context = active
      ? { activeKeywords: [...active] } as unknown as VariantContext
      : null;
    client.sendNotification(VARIANT_CONTEXT_CHANGED_NOTIFICATION, {
      textDocument: { uri },
      context,
    });
    if (active) activeByUri.set(uri, active);
    else activeByUri.delete(uri);
    updateStatus();
    refreshDimming();
  };

  const pickCommand = vscode.commands.registerCommand(
    'unityShaderNav.pickVariantContext',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !SUPPORTED_LANGUAGES.has(editor.document.languageId)) return;
      const uri = editor.document.uri.toString();

      let keywords: string[];
      try {
        const result = await client.sendRequest<GetVariantKeywordsResult>(
          GET_VARIANT_KEYWORDS_REQUEST,
          { textDocument: { uri } } satisfies GetVariantKeywordsParams,
        );
        keywords = result.keywords;
      } catch {
        keywords = [];
      }

      if (keywords.length === 0) {
        vscode.window.showInformationMessage(
          'No variant keywords (#pragma multi_compile / shader_feature) found in this document.',
        );
        return;
      }

      const current = activeByUri.get(uri) ?? new Set<string>();
      const items: vscode.QuickPickItem[] = [
        {
          label: '$(clear) Clear (conservative)',
          description: 'Remove variant context — all branches treated as valid',
        },
        ...keywords.sort().map((kw) => ({
          label: kw,
          picked: current.has(kw),
        })),
      ];

      const picks = await vscode.window.showQuickPick(items, {
        title: 'Select active variant keywords',
        canPickMany: true,
        placeHolder: 'Toggle keywords to set the active variant context',
      });

      if (picks === undefined) return; // user cancelled

      if (picks.some((p) => p.label.startsWith('$(clear)'))) {
        sendContext(uri, null);
        return;
      }

      const active = new Set(picks.map((p) => p.label));
      sendContext(uri, active);
    },
  );

  const activeEditor = vscode.window.onDidChangeActiveTextEditor(() => updateStatus());

  const closeDoc = vscode.workspace.onDidCloseTextDocument(({ uri }) => {
    const key = uri.toString();
    if (activeByUri.has(key)) {
      activeByUri.delete(key);
      client.sendNotification(VARIANT_CONTEXT_CHANGED_NOTIFICATION, {
        textDocument: { uri: key },
        context: null,
      });
    }
  });

  updateStatus();

  return {
    dispose() {
      statusItem.dispose();
      pickCommand.dispose();
      activeEditor.dispose();
      closeDoc.dispose();
    },
  };
}

/**
 * Restore the server's stored context for a document (e.g. on editor reload).
 * Converts the wire-format array back to a Set for local tracking.
 */
export async function restoreVariantContext(
  client: LanguageClient,
  uri: string,
): Promise<Set<string> | null> {
  try {
    const result = await client.sendRequest<VariantContextResult>(
      VARIANT_CONTEXT_REQUEST,
      { textDocument: { uri } },
    );
    return result.context ? new Set(result.context.activeKeywords) : null;
  } catch {
    return null;
  }
}
