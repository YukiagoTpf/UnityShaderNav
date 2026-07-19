import type {
  CompletionItem,
  Color,
  ColorInformation,
  ColorPresentation,
  CodeAction,
  CodeActionContext,
  Diagnostic,
  DocumentHighlight,
  DocumentSymbol,
  FormattingOptions,
  Hover,
  Location,
  LocationLink,
  Position,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  CancellationToken,
} from 'vscode-languageserver/node';
import type {
  CompileProfileRunResult,
  PortabilityReport,
  PortabilityTarget,
} from '@unity-shader-nav/shared';

export interface RequestCancellationInput {
  readonly cancellation?: CancellationToken;
}

export interface IndexedDocumentSnapshot {
  readonly uri: string;
  readonly languageId: string;
  readonly text: string;
  readonly openId: number;
  readonly version: number;
}

export interface IndexedDocumentSource {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  getText(): string;
}

export interface NavigationObserver {
  trace?(event: string, data: Record<string, unknown>): void;
  caseInsensitiveInclude?(includePath: string, absolutePath: string): void;
}

export interface DefinitionAtInput extends RequestCancellationInput {
  readonly document: IndexedDocumentSnapshot;
  readonly position: Position;
  readonly observer?: NavigationObserver;
}

export interface ReferencesAtInput extends RequestCancellationInput {
  readonly document: IndexedDocumentSnapshot;
  readonly position: Position;
  readonly includeDeclaration: boolean;
}

export interface DocumentPositionInput extends RequestCancellationInput {
  readonly document: IndexedDocumentSnapshot;
  readonly position: Position;
}

export interface CodeActionsAtInput extends RequestCancellationInput {
  readonly document: IndexedDocumentSnapshot;
  readonly range: import('vscode-languageserver/node').Range;
  readonly context: CodeActionContext;
}

export interface PortabilityReportAtInput extends RequestCancellationInput {
  readonly document: IndexedDocumentSnapshot;
  readonly target: PortabilityTarget;
  readonly compilerResult?: CompileProfileRunResult;
}

export interface ColorPresentationAtInput extends RequestCancellationInput {
  readonly document: IndexedDocumentSnapshot;
  readonly range: import('vscode-languageserver/node').Range;
  readonly color: Color;
}

export interface DocumentFormattingAtInput extends RequestCancellationInput {
  readonly document: IndexedDocumentSnapshot;
  readonly options: FormattingOptions;
}

export interface RenamePreparation {
  readonly kind: 'ready';
  readonly range: import('vscode-languageserver/node').Range;
  readonly placeholder: string;
}

export interface RenameFailure {
  readonly kind: 'failure';
  readonly message: string;
}

export type RenamePreparationOutcome = RenamePreparation | RenameFailure | null;
export type RenameEditOutcome = WorkspaceEdit | RenameFailure | null;

export function isRenameFailure(
  outcome: RenamePreparationOutcome | RenameEditOutcome,
): outcome is RenameFailure {
  return !!outcome && 'kind' in outcome && outcome.kind === 'failure';
}

export interface IndexedDocumentQueryInput extends RequestCancellationInput {
  readonly uri: string;
  readonly document?: IndexedDocumentSnapshot;
}

/** Handler-facing behavior. Mutable index implementations stay behind it. */
export interface IndexedWorkspace {
  updateDocument(document: IndexedDocumentSnapshot): Promise<boolean>;
  closeDocument(input: { readonly uri: string; readonly openId: number }): Promise<void>;
  diagnosticsAt(
    document: IndexedDocumentSnapshot,
    cancellation?: CancellationToken,
  ): Promise<Diagnostic[] | null>;
  portabilityReportAt(input: PortabilityReportAtInput): Promise<PortabilityReport | null>;
  codeActionsAt(input: CodeActionsAtInput): Promise<CodeAction[]>;
  definitionAt(input: DefinitionAtInput): Promise<LocationLink[] | Location[] | null>;
  referencesAt(input: ReferencesAtInput): Promise<Location[] | null>;
  hoverAt(input: DocumentPositionInput): Promise<Hover | null>;
  completionAt(input: DocumentPositionInput): Promise<CompletionItem[] | null>;
  documentColors(input: IndexedDocumentQueryInput): Promise<ColorInformation[]>;
  colorPresentations(input: ColorPresentationAtInput): Promise<ColorPresentation[]>;
  formatDocument(input: DocumentFormattingAtInput): Promise<TextEdit[] | null>;
  signatureHelpAt(input: DocumentPositionInput): Promise<SignatureHelp | null>;
  highlightsAt(input: DocumentPositionInput): Promise<DocumentHighlight[] | null>;
  prepareRenameAt(input: DocumentPositionInput): Promise<RenamePreparationOutcome>;
  renameAt(
    input: DocumentPositionInput & { readonly newName: string },
  ): Promise<RenameEditOutcome>;
  documentSymbols(input: IndexedDocumentQueryInput): Promise<DocumentSymbol[] | null>;
  semanticTokens(input: IndexedDocumentQueryInput): Promise<SemanticTokens>;
  workspaceSymbols(query: string): SymbolInformation[];
  workspaceSymbols(query: string, cancellation: CancellationToken): Promise<SymbolInformation[]>;
}

export type OpenDocumentsProvider = () => Iterable<IndexedDocumentSnapshot>;

/** Routing surface shared by document lifecycle and navigation adapters. */
export interface IndexedWorkspaceService {
  workspaceFor(uri: string): IndexedWorkspace | undefined;
  servingWorkspaceFor(uri: string): IndexedWorkspace | undefined;
  workspaceForOrCreateFile(
    uri: string,
    shouldCreate?: () => boolean,
  ): Promise<IndexedWorkspace | undefined>;
  releaseDocument(uri: string): Promise<void>;
  configureOpenDocumentsProvider(provider: OpenDocumentsProvider): void;
  workspaceSymbols(query: string): SymbolInformation[];
  workspaceSymbols(query: string, cancellation: CancellationToken): Promise<SymbolInformation[]>;
}

export interface DiagnosticWorkspaceService extends IndexedWorkspaceService {
  configureDiagnosticsRefresh(refresh: () => void): void;
}

export type IndexedWorkspaceRequestRouter =
  Pick<IndexedWorkspaceService, 'servingWorkspaceFor'>
  & Partial<Pick<
    IndexedWorkspaceService,
    'workspaceFor' | 'workspaceForOrCreateFile'
  >>;

export interface IndexedDocumentRegistry {
  snapshot(uri: string): IndexedDocumentSnapshot | undefined;
  openSnapshots(): readonly IndexedDocumentSnapshot[];
}

/** Open-document registry with lifecycle observation for revision projections. */
export interface IndexedDocumentLifecycleRegistry extends IndexedDocumentRegistry {
  onDidCloseSnapshot(handler: (document: IndexedDocumentSnapshot) => void): void;
}

/**
 * Resolve a request without waiting on an existing non-serving root. When no
 * route exists, a still-current open session may lazily recreate its owner.
 */
export async function workspaceForDocumentRequest(
  document: IndexedDocumentSnapshot,
  registry: Pick<IndexedDocumentRegistry, 'snapshot'>,
  router: IndexedWorkspaceRequestRouter,
): Promise<IndexedWorkspace | undefined> {
  const serving = router.servingWorkspaceFor(document.uri);
  if (serving) return serving;
  if (!router.workspaceFor || !router.workspaceForOrCreateFile) return undefined;
  if (router.workspaceFor(document.uri)) return undefined;

  return router.workspaceForOrCreateFile(document.uri, () => (
    registry.snapshot(document.uri)?.openId === document.openId
  ));
}

/**
 * Capture an immutable request/update input. The lifecycle registry supplies
 * openId explicitly, making it the single source of document identity.
 */
export function snapshotDocument(
  document: IndexedDocumentSource,
  openId: number,
): IndexedDocumentSnapshot {
  return {
    uri: document.uri,
    languageId: document.languageId,
    text: document.getText(),
    openId,
    version: document.version,
  };
}
