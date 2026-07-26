import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { NotificationHub } from './notificationHub';
import {
  COMPILER_MAPPING_REQUEST,
  COMPILER_PROFILES_REQUEST,
  COMPILER_VIEWS_REQUEST,
  COMPILER_VIRTUAL_DOCUMENT_CHANGED_NOTIFICATION,
  COMPILER_VIRTUAL_DOCUMENT_REQUEST,
  COMPILER_VIRTUAL_DOCUMENT_SCHEME,
  GO_TO_GENERATED_MAPPING_COMMAND,
  GO_TO_PREPROCESSED_MAPPING_COMMAND,
  GO_TO_SOURCE_MAPPING_COMMAND,
  OPEN_GENERATED_VIEW_COMMAND,
  OPEN_PREPROCESSED_VIEW_COMMAND,
  OPEN_SOURCE_VIEW_COMMAND,
  type CompileProfile,
  type CompileProfileDiscovery,
  type CompilerMappingParams,
  type CompilerMappedLocation,
  type CompilerMappingResult,
  type CompilerProfilesParams,
  type CompilerViewKind,
  type CompilerViewsParams,
  type CompilerViewsResult,
  type CompilerVirtualDocumentChangedParams,
  type CompilerVirtualDocumentParams,
  type CompilerVirtualDocumentResult,
} from '@unity-shader-nav/shared';

export interface CompilerViewCommandArgument {
  readonly profileName?: string;
  readonly inspect?: true;
}

export function setupCompilerViews(
  client: LanguageClient,
  notifications: NotificationHub,
  context: vscode.ExtensionContext,
  reportError: (message: string, error: unknown) => void,
): void {
  const changed = new vscode.EventEmitter<vscode.Uri>();
  let activeEvidence: Extract<CompilerViewsResult, { status: 'available' }> | undefined;
  let selectedProfile: CompileProfile | undefined;

  context.subscriptions.push(changed);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
    COMPILER_VIRTUAL_DOCUMENT_SCHEME,
    {
      onDidChange: changed.event,
      async provideTextDocumentContent(uri) {
        try {
          const result = await client.sendRequest<CompilerVirtualDocumentResult>(
            COMPILER_VIRTUAL_DOCUMENT_REQUEST,
            { uri: uri.toString() } satisfies CompilerVirtualDocumentParams,
          );
          return result.status === 'available'
            ? result.content
            : '// UnityShaderNav compiler evidence is no longer available.';
        } catch (error) {
          reportError('Failed to load compiler virtual document', error);
          return '// UnityShaderNav failed to load compiler evidence.';
        }
      },
    },
  ));
  context.subscriptions.push(notifications.on(
    COMPILER_VIRTUAL_DOCUMENT_CHANGED_NOTIFICATION,
    (params: CompilerVirtualDocumentChangedParams) => {
      for (const uri of params.uris) changed.fire(vscode.Uri.parse(uri));
    },
  ));

  const profilesFor = async (uri: string): Promise<CompileProfile | undefined> => {
    const discovery = await client.sendRequest<CompileProfileDiscovery>(
      COMPILER_PROFILES_REQUEST,
      { textDocument: { uri } } satisfies CompilerProfilesParams,
    );
    if (discovery.status === 'adapter-unavailable') {
      void vscode.window.showWarningMessage(
        `Compiler views unavailable: ${discovery.reason}.`,
      );
      return undefined;
    }
    const rememberedProfile = selectedProfile;
    if (rememberedProfile) {
      const current = discovery.profiles.find((profile) => (
        sameProfile(profile, rememberedProfile)
      ));
      if (current) return current;
    }
    if (discovery.profiles.length === 1) {
      selectedProfile = discovery.profiles[0];
      return selectedProfile;
    }
    if (discovery.profiles.length === 0) {
      void vscode.window.showWarningMessage(
        'Compiler views unavailable: the Adapter reported no verified compile profile.',
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      discovery.profiles.map((profile) => ({
        label: profile.name,
        description: `${profile.platform} · ${profile.graphicsApi}`,
        profile,
      })),
      {
        title: 'Select verified compiler profile',
        placeHolder: 'Compiler evidence is profile-specific',
      },
    );
    selectedProfile = picked?.profile;
    return selectedProfile;
  };

  const loadViews = async (
    argument?: CompilerViewCommandArgument,
  ): Promise<CompilerViewsResult | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const uri = editor.document.uri.scheme === COMPILER_VIRTUAL_DOCUMENT_SCHEME
      ? activeEvidence?.sourceUri
      : editor.document.uri.toString();
    if (!uri) return undefined;
    let profile: CompileProfile | undefined;
    if (argument?.profileName) {
      const discovery = await client.sendRequest<CompileProfileDiscovery>(
        COMPILER_PROFILES_REQUEST,
        { textDocument: { uri } } satisfies CompilerProfilesParams,
      );
      if (discovery.status === 'available') {
        profile = discovery.profiles.find(({ name }) => name === argument.profileName);
      }
    } else {
      profile = await profilesFor(uri);
    }
    if (!profile) {
      if (argument?.profileName) {
        void vscode.window.showWarningMessage(
          `Compiler profile "${argument.profileName}" is not available.`,
        );
      }
      return undefined;
    }
    selectedProfile = profile;
    const result = await client.sendRequest<CompilerViewsResult>(
      COMPILER_VIEWS_REQUEST,
      {
        textDocument: { uri },
        profile,
      } satisfies CompilerViewsParams,
    );
    if (result.status === 'available') activeEvidence = result;
    else {
      void vscode.window.showWarningMessage(
        `Compiler views unavailable: ${result.reason}.`,
      );
    }
    return result;
  };

  const openView = async (
    kind: CompilerViewKind,
    argument?: CompilerViewCommandArgument,
  ): Promise<CompilerViewsResult | undefined> => {
    try {
      const result = await loadViews(argument);
      if (!result || result.status !== 'available' || argument?.inspect) return result;
      const target = kind === 'source'
        ? result.sourceUri
        : result.views.find((view) => view.kind === kind)?.uri;
      if (!target) {
        void vscode.window.showWarningMessage(`No ${kind} compiler view was supplied.`);
        return result;
      }
      const document = await openCompilerDocument(target);
      await vscode.window.showTextDocument(document, { preview: false });
      return result;
    } catch (error) {
      reportError(`Failed to open ${kind} compiler view`, error);
      return undefined;
    }
  };

  const navigate = async (
    target: CompilerViewKind,
    inspect = false,
  ): Promise<CompilerMappingResult | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    try {
      const result = await client.sendRequest<CompilerMappingResult>(
        COMPILER_MAPPING_REQUEST,
        {
          uri: editor.document.uri.toString(),
          position: editor.selection.active,
          target,
          ...(editor.document.uri.scheme === COMPILER_VIRTUAL_DOCUMENT_SCHEME
            ? {}
            : activeEvidence ? { evidenceId: activeEvidence.evidenceId } : {}),
        } satisfies CompilerMappingParams,
      );
      if (inspect) return result;
      if (result.status !== 'mapped') {
        void vscode.window.showWarningMessage(
          `No reliable compiler mapping at this location: ${result.reason}.`,
        );
        return result;
      }
      const picked = await pickLocation(result.locations);
      if (!picked) return result;
      const document = await openCompilerDocument(picked.uri);
      const shown = await vscode.window.showTextDocument(document, { preview: false });
      shown.selection = new vscode.Selection(
        toVscodePosition(picked.range.start),
        toVscodePosition(picked.range.end),
      );
      shown.revealRange(new vscode.Range(
        toVscodePosition(picked.range.start),
        toVscodePosition(picked.range.end),
      ));
      return result;
    } catch (error) {
      reportError(`Failed to navigate to ${target} compiler mapping`, error);
      return undefined;
    }
  };

  context.subscriptions.push(vscode.commands.registerCommand(
    OPEN_SOURCE_VIEW_COMMAND,
    (argument?: CompilerViewCommandArgument) => openView('source', argument),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    OPEN_PREPROCESSED_VIEW_COMMAND,
    (argument?: CompilerViewCommandArgument) => openView('preprocessed', argument),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    OPEN_GENERATED_VIEW_COMMAND,
    (argument?: CompilerViewCommandArgument) => openView('generated', argument),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    GO_TO_SOURCE_MAPPING_COMMAND,
    (inspect?: boolean) => navigate('source', inspect === true),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    GO_TO_PREPROCESSED_MAPPING_COMMAND,
    (inspect?: boolean) => navigate('preprocessed', inspect === true),
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    GO_TO_GENERATED_MAPPING_COMMAND,
    (inspect?: boolean) => navigate('generated', inspect === true),
  ));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    { scheme: COMPILER_VIRTUAL_DOCUMENT_SCHEME },
    {
      async provideDefinition(document, position) {
        try {
          const result = await client.sendRequest<CompilerMappingResult>(
            COMPILER_MAPPING_REQUEST,
            {
              uri: document.uri.toString(),
              position,
              target: 'source',
            } satisfies CompilerMappingParams,
          );
          return result.status === 'mapped'
            ? result.locations.map((location) => new vscode.Location(
                vscode.Uri.parse(location.uri),
                new vscode.Range(
                  toVscodePosition(location.range.start),
                  toVscodePosition(location.range.end),
                ),
              ))
            : [];
        } catch (error) {
          reportError('Failed to resolve compiler source mapping', error);
          return [];
        }
      },
    },
  ));
}

function sameProfile(left: CompileProfile, right: CompileProfile): boolean {
  return left.name === right.name
    && left.platform === right.platform
    && left.graphicsApi === right.graphicsApi
    && left.capability === right.capability;
}

async function pickLocation(
  locations: readonly CompilerMappedLocation[],
): Promise<CompilerMappedLocation | undefined> {
  if (locations.length === 1) return locations[0];
  const picked = await vscode.window.showQuickPick(locations.map((location) => ({
    label: `${vscode.workspace.asRelativePath(vscode.Uri.parse(location.uri), false)}:${location.range.start.line + 1}`,
    description: `${location.provenance.method} · ${location.provenance.granularity}`,
    location,
  })), {
    title: 'Select compiler mapping',
    placeHolder: 'The source region occurs more than once in this compiler view',
  });
  return picked?.location;
}

function toVscodePosition(
  position: { readonly line: number; readonly character: number },
): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

async function openCompilerDocument(uri: string): Promise<vscode.TextDocument> {
  let document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
  if (
    document.uri.scheme === COMPILER_VIRTUAL_DOCUMENT_SCHEME
    && document.languageId !== 'hlsl'
  ) {
    document = await vscode.languages.setTextDocumentLanguage(document, 'hlsl');
  }
  return document;
}
