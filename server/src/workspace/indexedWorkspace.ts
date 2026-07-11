import type {
  Location,
  LocationLink,
  Position,
} from 'vscode-languageserver/node';

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

export interface DefinitionAtInput {
  readonly document: IndexedDocumentSnapshot;
  readonly position: Position;
  readonly observer?: NavigationObserver;
}

export interface ReferencesAtInput {
  readonly document: IndexedDocumentSnapshot;
  readonly position: Position;
  readonly includeDeclaration: boolean;
}

/** Handler-facing behavior. Mutable index implementations stay behind it. */
export interface IndexedWorkspace {
  updateDocument(document: IndexedDocumentSnapshot): Promise<boolean>;
  closeDocument(input: { readonly uri: string; readonly openId: number }): Promise<void>;
  definitionAt(input: DefinitionAtInput): Promise<LocationLink[] | Location[] | null>;
  referencesAt(input: ReferencesAtInput): Promise<Location[] | null>;
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
