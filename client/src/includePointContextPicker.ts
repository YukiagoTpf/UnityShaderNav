import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import {
  INCLUDE_POINT_CONTEXT_CHANGED_NOTIFICATION,
  INCLUDE_POINT_CONTEXTS_REQUEST,
  INDEX_STATUS_NOTIFICATION,
  type IndexStatusSnapshot,
  type IncludePointContext,
  type IncludePointContextChangedParams,
  type IncludePointContextsParams,
  type IncludePointContextsResult,
} from '@unity-shader-nav/shared';

export const PICK_INCLUDE_POINT_CONTEXT_COMMAND =
  'unityShaderNav.pickIncludePointContext';

interface ActiveSelection {
  readonly revision: number;
  readonly publicationId: string;
  readonly contextId: string;
}

interface ContextQuickPickItem extends vscode.QuickPickItem {
  readonly context?: IncludePointContext;
  readonly auto?: true;
}

/** Optional command argument for automation; ordinary UI invocation omits it. */
export interface PickIncludePointContextArgument {
  readonly auto?: true;
  readonly inspect?: true;
  readonly contextId?: string;
  readonly entryPoint?: string;
}

export interface PickIncludePointContextResult extends IncludePointContextsResult {
  readonly selection: IncludePointContext | null;
}

export interface IncludePointContextPicker {
  dispose(): void;
}

/**
 * Session-only status item + QuickPick for one revision-grounded include
 * point. The client owns selection lifetime; the server receives only an
 * ephemeral mirror so standard LSP requests can consume it.
 */
export function createIncludePointContextPicker(
  client: LanguageClient,
  refreshFeatures: () => void,
): IncludePointContextPicker {
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    91,
  );
  statusItem.name = 'UnityShaderNav Shader Context';
  statusItem.command = PICK_INCLUDE_POINT_CONTEXT_COMMAND;
  const selections = new Map<string, ActiveSelection>();
  let requestIdentity = 0;
  let disposed = false;

  const notifySelection = (
    folderUri: string,
    selection: ActiveSelection | null,
  ): void => {
    client.sendNotification(
      INCLUDE_POINT_CONTEXT_CHANGED_NOTIFICATION,
      {
        folderUri,
        selection: selection
          ? {
            publicationId: selection.publicationId,
            contextId: selection.contextId,
          }
          : null,
      } satisfies IncludePointContextChangedParams,
    );
  };

  const requestContexts = async (uri: string): Promise<IncludePointContextsResult> => {
    try {
      return await client.sendRequest<IncludePointContextsResult>(
        INCLUDE_POINT_CONTEXTS_REQUEST,
        { textDocument: { uri } } satisfies IncludePointContextsParams,
      );
    } catch {
      return { contexts: [] };
    }
  };

  const acceptSelection = (
    result: IncludePointContextsResult,
    announceFallback: boolean,
  ): IncludePointContext | undefined => {
    if (!result.folderUri || !result.publicationId) return undefined;
    const selected = selections.get(result.folderUri);
    if (!selected) return undefined;
    const context = selected.revision === result.revision
      && selected.publicationId === result.publicationId
      ? result.contexts.find(({ id }) => id === selected.contextId)
      : undefined;
    if (context) return context;

    selections.delete(result.folderUri);
    notifySelection(result.folderUri, null);
    refreshFeatures();
    if (announceFallback) {
      void vscode.window.showInformationMessage(
        'The selected Shader Context is no longer available; switched to Auto.',
      );
    }
    return undefined;
  };

  const updateStatus = async (announceFallback = true): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'hlsl') {
      statusItem.hide();
      return;
    }
    const uri = editor.document.uri.toString();
    const identity = ++requestIdentity;
    const result = await requestContexts(uri);
    if (disposed || identity !== requestIdentity) return;
    if (vscode.window.activeTextEditor?.document.uri.toString() !== uri) return;
    const selected = acceptSelection(result, announceFallback);
    if (result.contexts.length === 0) {
      statusItem.hide();
      return;
    }

    if (selected) {
      statusItem.text = `$(symbol-namespace) Context: ${shortContextLabel(selected)}`;
      statusItem.tooltip = contextTooltip(selected, result.revision);
    } else {
      statusItem.text = '$(symbol-namespace) Context: Auto';
      statusItem.tooltip = [
        'Auto uses conservative shared-file analysis.',
        `${result.contexts.length} known include-point Context${result.contexts.length === 1 ? '' : 's'}.`,
      ].join('\n');
    }
    statusItem.show();
  };

  const command = vscode.commands.registerCommand(
    PICK_INCLUDE_POINT_CONTEXT_COMMAND,
    async (
      requested?: PickIncludePointContextArgument,
    ): Promise<PickIncludePointContextResult | undefined> => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'hlsl') return;
      const result = await requestContexts(editor.document.uri.toString());
      const current = acceptSelection(result, false);
      if (requested?.inspect) return { ...result, selection: current ?? null };
      if (
        !result.folderUri
        || result.revision === undefined
        || !result.publicationId
        || result.contexts.length === 0
      ) {
        void vscode.window.showInformationMessage(
          'No Shader include-point Context reaches this file in the published index.',
        );
        return { ...result, selection: null };
      }
      const items: ContextQuickPickItem[] = [
        {
          label: '$(circle-outline) Auto (conservative)',
          description: 'Do not select an include-point Context',
          auto: true,
          picked: current === undefined,
        },
        ...result.contexts.map((context): ContextQuickPickItem => ({
          label: contextLabel(context),
          description: `${context.entryPoint} · ${sourceLabel(
            context.includeLocation.uri,
            context.includeLocation.range.start.line,
          )}`,
          detail: `Shader source ${vscode.workspace.asRelativePath(
            vscode.Uri.parse(context.shaderUri),
            false,
          )} · chain depth ${context.chainDepth}`,
          picked: current?.id === context.id,
          context,
        })),
      ];
      const directContext = requested?.contextId
        ? result.contexts.find(({ id }) => id === requested.contextId)
        : requested?.entryPoint
          ? result.contexts.find(({ entryPoint }) => entryPoint === requested.entryPoint)
          : undefined;
      const picked: ContextQuickPickItem | undefined = requested
        ? requested.auto
          ? items[0]
          : directContext
            ? items.find(({ context }) => context?.id === directContext.id)
            : undefined
        : await vscode.window.showQuickPick(items, {
          title: 'Select Shader include-point Context',
          placeHolder: 'One Context sharpens shared-file presentation and analysis',
          matchOnDescription: true,
          matchOnDetail: true,
        });
      if (!picked) return { ...result, selection: current ?? null };

      let selection: IncludePointContext | null;
      if (picked.auto || !picked.context) {
        selections.delete(result.folderUri);
        notifySelection(result.folderUri, null);
        selection = null;
      } else {
        const activeSelection = {
          revision: result.revision,
          publicationId: result.publicationId,
          contextId: picked.context.id,
        };
        selections.set(result.folderUri, activeSelection);
        notifySelection(result.folderUri, activeSelection);
        selection = picked.context;
      }
      refreshFeatures();
      await updateStatus(false);
      return { ...result, selection };
    },
  );

  const activeEditor = vscode.window.onDidChangeActiveTextEditor(() => {
    void updateStatus();
  });
  const indexStatus = client.onNotification(
    INDEX_STATUS_NOTIFICATION,
    (snapshot: IndexStatusSnapshot) => {
      let cleared = false;
      const currentRevisions = new Map(snapshot.workspaces.map((workspace) => {
        const lifecycle = workspace.lifecycle;
        const revision = lifecycle.state === 'ready'
          ? lifecycle.revision
          : lifecycle.servingRevision;
        return [workspace.folderUri, revision] as const;
      }));
      for (const [folderUri, selection] of selections) {
        if (currentRevisions.get(folderUri) === selection.revision) continue;
        selections.delete(folderUri);
        notifySelection(folderUri, null);
        cleared = true;
      }
      if (cleared) refreshFeatures();
      void updateStatus();
    },
  );
  const clientState = client.onDidChangeState(({ newState }) => {
    if (newState === State.Running) void updateStatus();
    if (newState === State.Starting || newState === State.Stopped) {
      if (selections.size > 0) {
        selections.clear();
        refreshFeatures();
      }
      statusItem.hide();
    }
  });

  void updateStatus(false);

  return {
    dispose() {
      disposed = true;
      requestIdentity++;
      statusItem.dispose();
      command.dispose();
      activeEditor.dispose();
      indexStatus.dispose();
      clientState.dispose();
      selections.clear();
    },
  };
}

export function shortContextLabel(context: IncludePointContext): string {
  return `${passLabel(context)} · ${context.stage}`;
}

export function contextLabel(context: IncludePointContext): string {
  return `${context.shaderName} · ${shortContextLabel(context)}`;
}

function passLabel(context: IncludePointContext): string {
  if (context.passName) return `Pass "${context.passName}"`;
  if (context.passIndex !== undefined) return `Pass ${context.passIndex + 1}`;
  return `SubShader ${context.subShaderIndex + 1}`;
}

function contextTooltip(context: IncludePointContext, revision: number | undefined): string {
  return [
    contextLabel(context),
    `Entry point: ${context.entryPoint}`,
    `Include point: ${sourceLabel(
      context.includeLocation.uri,
      context.includeLocation.range.start.line,
    )}`,
    `Chain depth: ${context.chainDepth}`,
    ...(revision !== undefined ? [`Published revision: ${revision}`] : []),
    '',
    'Navigation still retains every conservative candidate.',
  ].join('\n');
}

function sourceLabel(uri: string, zeroBasedLine: number): string {
  return `${vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false)}:${zeroBasedLine + 1}`;
}
