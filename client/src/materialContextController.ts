import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import {
  INDEX_STATUS_NOTIFICATION,
  MATERIAL_CONTEXT_CHANGED_NOTIFICATION,
  MATERIAL_CONTEXT_REQUEST,
  type IndexStatusSnapshot,
  type MaterialContextParams,
  type MaterialContextResult,
} from '@unity-shader-nav/shared';
import {
  materialContextDetails,
  materialContextStatus,
} from './materialContextPresentation';

export const SHOW_MATERIAL_CONTEXT_COMMAND =
  'unityShaderNav.showMaterialContext';

export interface ShowMaterialContextArgument {
  readonly inspect?: true;
}

export interface MaterialContextController {
  dispose(): void;
}

/**
 * Event-driven client projection for the connected Editor's selected Material.
 * Request generations prevent slow selection responses from replacing newer UI.
 */
export function createMaterialContextController(
  client: LanguageClient,
  refreshFeatures: () => void,
): MaterialContextController {
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90,
  );
  statusItem.name = 'UnityShaderNav Material Context';
  statusItem.command = SHOW_MATERIAL_CONTEXT_COMMAND;
  let requestGeneration = 0;
  let disposed = false;

  const requestContext = async (uri: string): Promise<MaterialContextResult> => {
    try {
      return await client.sendRequest<MaterialContextResult>(
        MATERIAL_CONTEXT_REQUEST,
        { textDocument: { uri } } satisfies MaterialContextParams,
      );
    } catch {
      return { status: 'unavailable', reason: 'source-unavailable' };
    }
  };

  const activeSourceUri = (): string | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (
      !editor
      || (editor.document.languageId !== 'shaderlab'
        && editor.document.languageId !== 'hlsl')
    ) return undefined;
    return editor.document.uri.toString();
  };

  const refresh = async (): Promise<MaterialContextResult | undefined> => {
    const uri = activeSourceUri();
    const generation = ++requestGeneration;
    if (!uri) {
      statusItem.hide();
      return undefined;
    }
    const result = await requestContext(uri);
    if (
      disposed
      || generation !== requestGeneration
      || activeSourceUri() !== uri
    ) return undefined;
    if (result.status === 'unavailable') {
      statusItem.hide();
      refreshFeatures();
      return result;
    }

    const presentation = materialContextStatus(result);
    statusItem.text = presentation.text;
    statusItem.tooltip = presentation.tooltip;
    statusItem.show();
    refreshFeatures();
    return result;
  };

  const command = vscode.commands.registerCommand(
    SHOW_MATERIAL_CONTEXT_COMMAND,
    async (
      argument?: ShowMaterialContextArgument,
    ): Promise<MaterialContextResult | undefined> => {
      const uri = activeSourceUri();
      if (!uri) return undefined;
      const result = await requestContext(uri);
      if (argument?.inspect) return result;
      if (result.status === 'unavailable') {
        void vscode.window.showInformationMessage(unavailableMessage(result.reason));
        return result;
      }
      await vscode.window.showQuickPick(materialContextDetails(result), {
        title: 'Selected Material Context (not the final draw Context)',
        placeHolder: 'Unity Editor Adapter evidence and explicit unknowns',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      return result;
    },
  );
  const activeEditor = vscode.window.onDidChangeActiveTextEditor(() => {
    void refresh();
  });
  const materialSelection = client.onNotification(
    MATERIAL_CONTEXT_CHANGED_NOTIFICATION,
    () => { void refresh(); },
  );
  const indexStatus = client.onNotification(
    INDEX_STATUS_NOTIFICATION,
    (_snapshot: IndexStatusSnapshot) => { void refresh(); },
  );
  const clientState = client.onDidChangeState(({ newState }) => {
    if (newState === State.Running) void refresh();
    if (newState === State.Starting || newState === State.Stopped) {
      requestGeneration++;
      statusItem.hide();
      refreshFeatures();
    }
  });

  void refresh();

  return {
    dispose() {
      disposed = true;
      requestGeneration++;
      statusItem.dispose();
      command.dispose();
      activeEditor.dispose();
      materialSelection.dispose();
      indexStatus.dispose();
      clientState.dispose();
    },
  };
}

function unavailableMessage(reason: Extract<
  MaterialContextResult,
  { readonly status: 'unavailable' }
>['reason']): string {
  switch (reason) {
    case 'no-selection':
      return 'No Material is selected in the connected Unity Editor.';
    case 'asset-deleted':
      return 'The selected Material asset no longer exists.';
    case 'stale-source':
      return 'Material Context is stale for the current asset revision.';
    case 'selection-changed':
      return 'The Unity selection changed while Material Context was loading.';
    default:
      return 'Material Context is unavailable from the connected Unity Editor Adapter.';
  }
}
