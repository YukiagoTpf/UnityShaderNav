import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  EXPLAIN_CURRENT_PASS_COMMAND,
  MATERIAL_CONTEXT_CHANGED_NOTIFICATION,
  PASS_EXPLANATION_REQUEST,
  uriIdentityKey,
  type PassExplanationAnswer,
  type PassExplanationParams,
} from '@unity-shader-nav/shared';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { NotificationHub } from './notificationHub';
import {
  PassExplanationClientSession,
  passExplanationSourceUris,
  renderPassExplanationHtml,
  type PassExplanationClientSnapshot,
} from './passExplanationPresentation';

const PASS_EXPLANATION_VIEW_TYPE = 'unityShaderNav.passExplanation';

export interface PassExplanationRequestApi {
  request(
    params: PassExplanationParams,
    cancellation: vscode.CancellationToken,
  ): Promise<PassExplanationAnswer>;
  onMaterialContextChanged(handler: () => void): vscode.Disposable;
}

export interface PassExplanationController extends vscode.Disposable {
  explainCurrentPass(): Promise<void>;
  inspect(): PassExplanationClientSnapshot;
}

export interface ExplainCurrentPassArgument {
  readonly inspect?: true;
}

export function createLanguageClientPassExplanationApi(
  client: LanguageClient,
  notifications: NotificationHub,
): PassExplanationRequestApi {
  return {
    request: (params, cancellation) => client.sendRequest<PassExplanationAnswer>(
      PASS_EXPLANATION_REQUEST,
      params,
      cancellation,
    ),
    // Shared with materialContextController, so this must go through the hub:
    // a direct client.onNotification for the same method is evicted by whoever
    // registers last.
    onMaterialContextChanged: (handler) => notifications.on(
      MATERIAL_CONTEXT_CHANGED_NOTIFICATION,
      handler,
    ),
  };
}

/**
 * One session-scoped, read-only panel. Every answer is an explicit request for
 * the currently active ShaderLab/HLSL document; no background refresh occurs.
 */
export function createPassExplanationController(
  api: PassExplanationRequestApi,
  reportError: (message: string, error: unknown) => void,
): PassExplanationController {
  const session = new PassExplanationClientSession();
  let panel: vscode.WebviewPanel | undefined;
  let activeRequest: {
    readonly cancellation: vscode.CancellationTokenSource;
    readonly changedUris: Set<string>;
  } | undefined;
  let disposed = false;

  const cancelActiveRequest = (): void => {
    const request = activeRequest;
    activeRequest = undefined;
    if (!request) return;
    request.cancellation.cancel();
    request.cancellation.dispose();
  };

  const updatePanel = (): void => {
    if (!panel || disposed) return;
    panel.webview.html = renderPassExplanationHtml(session.snapshot(), {
      nonce: randomBytes(18).toString('base64'),
    });
  };

  const show = (): void => {
    if (panel) {
      panel.reveal(panel.viewColumn, false);
      updatePanel();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      PASS_EXPLANATION_VIEW_TYPE,
      'UnityShaderNav Pass Explanation',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: false,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    updatePanel();
  };

  const explainCurrentPass = async (): Promise<void> => {
    if (disposed) return;
    cancelActiveRequest();

    const sourceUri = activeShaderSourceUri();
    if (!sourceUri) {
      session.explainFromShaderSourceOnly(
        'Open a ShaderLab or HLSL source, then run “Explain Current Pass” again.',
      );
      show();
      updatePanel();
      return;
    }

    const generation = session.begin(sourceUri);
    const request = {
      cancellation: new vscode.CancellationTokenSource(),
      changedUris: new Set<string>(),
    };
    activeRequest = request;
    show();
    updatePanel();
    try {
      const answer = await api.request({
        textDocument: { uri: sourceUri },
      }, request.cancellation.token);
      if (
        activeRequest !== request
        || request.cancellation.token.isCancellationRequested
      ) return;
      const answerSourceUris = passExplanationSourceUris(sourceUri, answer);
      if (
        answerSourceUris.some((uri) => (
          sourceMutationIdentityKeys(uri).some((identity) => (
            request.changedUris.has(identity)
          ))
        ))
      ) {
        if (session.invalidate('source-changed')) updatePanel();
        return;
      }
      if (session.settle(generation, sourceUri, answer)) updatePanel();
    } catch (error) {
      if (
        activeRequest !== request
        || request.cancellation.token.isCancellationRequested
        || error instanceof vscode.CancellationError
      ) return;
      const failed = session.fail(
        generation,
        sourceUri,
        'The local Pass explanation request failed. See the UnityShaderNav output for details.',
      );
      if (!failed) return;
      updatePanel();
      reportError('Failed to explain the current Pass', error);
    } finally {
      if (activeRequest === request) {
        activeRequest = undefined;
        request.cancellation.dispose();
      }
    }
  };

  const command = vscode.commands.registerCommand(
    EXPLAIN_CURRENT_PASS_COMMAND,
    (
      argument?: ExplainCurrentPassArgument,
    ): PassExplanationClientSnapshot | Promise<void> => {
      if (argument?.inspect) return session.snapshot();
      return explainCurrentPass();
    },
  );
  const observeSourceMutation = (uri: vscode.Uri): void => {
    const changedUri = normalizedUri(uri.toString());
    activeRequest?.changedUris.add(changedUri);
    if (!session.sourceUris().some((uri) => (
      sourceMutationIdentityKeys(uri).includes(changedUri)
    ))) {
      return;
    }
    cancelActiveRequest();
    if (session.invalidate('source-changed')) updatePanel();
  };
  const sourceChanged = vscode.workspace.onDidChangeTextDocument(({ document }) => {
    observeSourceMutation(document.uri);
  });
  const sourceWatcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{shader,hlsl,cginc,hlslinc,compute,mat,meta}',
  );
  const watchedSourceChanged = sourceWatcher.onDidChange(observeSourceMutation);
  const watchedSourceCreated = sourceWatcher.onDidCreate(observeSourceMutation);
  const watchedSourceDeleted = sourceWatcher.onDidDelete(observeSourceMutation);
  const materialContextChanged = api.onMaterialContextChanged(() => {
    cancelActiveRequest();
    if (session.invalidate('material-context-changed')) updatePanel();
  });

  return {
    explainCurrentPass,
    inspect: () => session.snapshot(),
    dispose() {
      disposed = true;
      cancelActiveRequest();
      command.dispose();
      sourceChanged.dispose();
      watchedSourceChanged.dispose();
      watchedSourceCreated.dispose();
      watchedSourceDeleted.dispose();
      sourceWatcher.dispose();
      materialContextChanged.dispose();
      panel?.dispose();
      panel = undefined;
    },
  };
}

function normalizedUri(value: string): string {
  try {
    return uriIdentityKey(vscode.Uri.parse(value).toString());
  } catch {
    return uriIdentityKey(value);
  }
}

/**
 * Unity stores importer state beside a project file as `<file>.meta`. Compare
 * the raw watcher event against the exact sidecar derived from a cited file;
 * never infer a source by stripping `.meta` from an arbitrary event.
 */
function sourceMutationIdentityKeys(sourceUri: string): readonly string[] {
  const sourceIdentity = normalizedUri(sourceUri);
  try {
    const sidecar = new URL(sourceUri);
    if (sidecar.protocol !== 'file:') return [sourceIdentity];
    sidecar.pathname = `${sidecar.pathname}.meta`;
    sidecar.search = '';
    sidecar.hash = '';
    return [sourceIdentity, normalizedUri(sidecar.href)];
  } catch {
    return [sourceIdentity];
  }
}

function activeShaderSourceUri(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (
    !editor
    || (editor.document.languageId !== 'shaderlab'
      && editor.document.languageId !== 'hlsl')
  ) return undefined;
  return editor.document.uri.toString();
}
