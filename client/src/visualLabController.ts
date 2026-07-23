import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import {
  OPEN_VISUAL_LAB_COMMAND,
  VISUAL_LAB_CAPTURE_REQUEST,
  VISUAL_LAB_SELECT_TARGET_REQUEST,
  VISUAL_LAB_STATE_CHANGED_NOTIFICATION,
  VISUAL_LAB_STATE_REQUEST,
  type VisualLabCaptureParams,
  type VisualLabSessionState,
  type VisualLabSelectTargetParams,
  type VisualLabSlot,
  type VisualLabStateChangedParams,
  type VisualLabStateParams,
} from '@unity-shader-nav/shared';
import {
  VisualLabClientSession,
  renderVisualLabHtml,
  type VisualLabClientSnapshot,
} from './visualLabPresentation';

const VISUAL_LAB_VIEW_TYPE = 'unityShaderNav.visualLab';

export interface VisualLabRequestApi {
  readonly connected: boolean;
  requestState(params: VisualLabStateParams): Promise<VisualLabSessionState>;
  selectTarget(params: VisualLabSelectTargetParams): Promise<VisualLabSessionState>;
  capture(params: VisualLabCaptureParams): Promise<VisualLabSessionState>;
  onStateChanged(
    handler: (params: VisualLabStateChangedParams) => void,
  ): vscode.Disposable;
  onConnectionChanged(
    handler: (connected: boolean) => void,
  ): vscode.Disposable;
}

export interface VisualLabController extends vscode.Disposable {
  show(): void;
  useCurrentSelectedMaterial(): Promise<void>;
  capture(slot: VisualLabSlot): Promise<void>;
  inspect(): VisualLabClientSnapshot;
}

export interface OpenVisualLabArgument {
  readonly inspect?: true;
}

/**
 * Isolates the Webview controller from LanguageClient overloads and keeps every
 * render request explicit in one small API.
 */
export function createLanguageClientVisualLabApi(
  client: LanguageClient,
): VisualLabRequestApi {
  return {
    get connected() {
      return client.state === State.Running;
    },
    requestState: (params) => client.sendRequest<VisualLabSessionState>(
      VISUAL_LAB_STATE_REQUEST,
      params,
    ),
    selectTarget: (params) => client.sendRequest<VisualLabSessionState>(
      VISUAL_LAB_SELECT_TARGET_REQUEST,
      params,
    ),
    capture: (params) => client.sendRequest<VisualLabSessionState>(
      VISUAL_LAB_CAPTURE_REQUEST,
      params,
    ),
    onStateChanged: (handler) => client.onNotification(
      VISUAL_LAB_STATE_CHANGED_NOTIFICATION,
      handler,
    ),
    onConnectionChanged: (handler) => client.onDidChangeState(({ newState }) => {
      handler(newState === State.Running);
    }),
  };
}

/**
 * Persistent single-panel Visual Lab. State notifications may invalidate or
 * replace evidence, but only Webview button messages call `capture`.
 */
export function createVisualLabController(
  api: VisualLabRequestApi,
  reportError: (message: string, error: unknown) => void,
): VisualLabController {
  const session = new VisualLabClientSession();
  if (!api.connected) session.disconnect();
  let panel: vscode.WebviewPanel | undefined;
  let sessionDocumentUri: string | undefined;
  let disposed = false;

  const updatePanel = (): void => {
    if (!panel || disposed) return;
    panel.webview.html = renderVisualLabHtml(session.snapshot(), {
      cspSource: panel.webview.cspSource,
      nonce: randomBytes(18).toString('base64'),
    });
  };

  const readState = async (): Promise<void> => {
    const generation = session.beginReadState();
    if (generation === undefined) return;
    updatePanel();
    const uri = sessionDocumentUri
      ?? currentSessionSourceUri(session.snapshot())
      ?? activeShaderSourceUri();
    if (!uri) {
      session.fail(
        generation,
        'read-state',
        'Open a ShaderLab or HLSL source to load an existing Visual Lab session.',
      );
      updatePanel();
      return;
    }
    sessionDocumentUri = uri;
    try {
      const state = await api.requestState({ textDocument: { uri } });
      if (session.settle(generation, state, 'read-state')) updatePanel();
    } catch (error) {
      if (session.fail(
        generation,
        'read-state',
        'Failed to load the existing Visual Lab session.',
      )) updatePanel();
      reportError('Failed to load existing Visual Lab state', error);
    }
  };

  const useCurrentSelectedMaterial = async (): Promise<void> => {
    const generation = session.beginUseCurrent();
    updatePanel();
    const uri = activeShaderSourceUri();
    if (!uri) {
      session.fail(
        generation,
        'use-current',
        'Open a ShaderLab or HLSL source before using the current selected Material.',
      );
      updatePanel();
      return;
    }
    sessionDocumentUri = uri;
    try {
      const state = await api.selectTarget({
        textDocument: { uri },
      });
      if (session.settle(generation, state, 'use-current')) updatePanel();
    } catch (error) {
      if (session.fail(
        generation,
        'use-current',
        'Failed to load the current selected Material from the connected Adapter.',
      )) updatePanel();
      reportError('Failed to load Visual Lab state', error);
    }
  };

  const capture = async (slot: VisualLabSlot): Promise<void> => {
    const generation = session.beginCapture(slot);
    if (generation === undefined) return;
    updatePanel();
    const state = session.snapshot().session;
    const uri = state?.status === 'available'
      ? state.target.source.revision.uri
      : undefined;
    if (!uri) {
      session.fail(
        generation,
        'capture',
        'The pinned Material source is unavailable. Use Current Selected Material again.',
        slot,
      );
      updatePanel();
      return;
    }
    try {
      const result = await api.capture({
        textDocument: { uri },
        slot,
      });
      if (session.settle(generation, result, 'capture', slot)) updatePanel();
    } catch (error) {
      if (session.fail(
        generation,
        'capture',
        `Failed to capture the ${slot} Visual Lab frame.`,
        slot,
      )) updatePanel();
      reportError(`Failed to capture Visual Lab ${slot} frame`, error);
    }
  };

  const show = (): void => {
    if (panel) {
      panel.reveal(panel.viewColumn, false);
      updatePanel();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      VISUAL_LAB_VIEW_TYPE,
      'UnityShaderNav Visual Lab',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isVisualLabMessage(message)) return;
      if (message.type === 'use-current-selected-material') {
        void useCurrentSelectedMaterial();
      } else if (message.type === 'capture-before') {
        void capture('before');
      } else {
        void capture('after');
      }
    });
    updatePanel();
    void readState();
  };

  const command = vscode.commands.registerCommand(
    OPEN_VISUAL_LAB_COMMAND,
    (argument?: OpenVisualLabArgument): VisualLabClientSnapshot | undefined => {
      if (argument?.inspect) return session.snapshot();
      show();
      return undefined;
    },
  );
  const stateChanged = api.onStateChanged(({ textDocument, state }) => {
    if (
      sessionDocumentUri
      && normalizedUri(textDocument.uri) !== normalizedUri(sessionDocumentUri)
    ) return;
    sessionDocumentUri = textDocument.uri;
    try {
      session.applyServerState(state);
    } catch (error) {
      session.invalidate('identity-changed');
      reportError('Rejected invalid Visual Lab state', error);
    }
    updatePanel();
  });
  const connectionChanged = api.onConnectionChanged((connected) => {
    if (connected) {
      session.connect();
      void readState();
    } else {
      session.disconnect();
    }
    updatePanel();
  });
  const sourceChanged = vscode.workspace.onDidChangeTextDocument(({ document }) => {
    if (!ownsSource(session.snapshot(), document.uri.toString())) return;
    session.invalidate('source-revision-changed');
    updatePanel();
  });

  return {
    show,
    useCurrentSelectedMaterial,
    capture,
    inspect: () => session.snapshot(),
    dispose() {
      disposed = true;
      command.dispose();
      stateChanged.dispose();
      connectionChanged.dispose();
      sourceChanged.dispose();
      panel?.dispose();
      panel = undefined;
    },
  };
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

function normalizedUri(value: string): string {
  try {
    return vscode.Uri.parse(value).toString();
  } catch {
    return value;
  }
}

function currentSessionSourceUri(
  snapshot: VisualLabClientSnapshot,
): string | undefined {
  const { session } = snapshot;
  if (!session) return undefined;
  if (session.status === 'available') return session.target.source.revision.uri;
  if (session.pinnedTarget) return session.pinnedTarget.source.revision.uri;
  for (const slot of [session.before, session.after]) {
    const frame = slot.status === 'current' || slot.status === 'stale'
      ? slot.frame
      : slot.status === 'capturing' || slot.status === 'failed'
        ? slot.previous?.frame
        : undefined;
    if (frame) return frame.target.source.revision.uri;
  }
  return undefined;
}

function ownsSource(snapshot: VisualLabClientSnapshot, uri: string): boolean {
  const { session } = snapshot;
  if (!session) return false;
  if (session.status === 'available' && session.target.source.revision.uri === uri) {
    return true;
  }
  if (
    session.status === 'unavailable'
    && session.pinnedTarget?.source.revision.uri === uri
  ) return true;
  return [session.before, session.after].some((slot) => {
    const frame = slot.status === 'current' || slot.status === 'stale'
      ? slot.frame
      : slot.status === 'capturing' || slot.status === 'failed'
        ? slot.previous?.frame
        : undefined;
    return frame?.target.source.revision.uri === uri;
  });
}

function isVisualLabMessage(value: unknown): value is {
  readonly type:
    | 'use-current-selected-material'
    | 'capture-before'
    | 'capture-after';
} {
  if (value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'type') return false;
  const type = (value as { readonly type?: unknown }).type;
  return type === 'use-current-selected-material'
    || type === 'capture-before'
    || type === 'capture-after';
}
