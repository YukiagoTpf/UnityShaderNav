import type { Connection } from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { uriKey } from '../uriKey';
import {
  snapshotDocument,
  type IndexedDocumentSnapshot,
  type IndexedDocumentLifecycleRegistry,
  type IndexedWorkspaceService,
} from '../workspace/indexedWorkspace';

export interface RegisteredDocuments extends IndexedDocumentLifecycleRegistry {
  readonly documents: TextDocuments<TextDocument>;
}

const LIVE_EDIT_COALESCE_MS = 75;

type TextDocumentConnection = Parameters<TextDocuments<TextDocument>['listen']>[0];
type TextDocumentNotification = { readonly textDocument: { readonly uri: string } };

function withDocumentUri<T extends TextDocumentNotification>(event: T, uri: string): T {
  if (uri === event.textDocument.uri) return event;
  return {
    ...event,
    textDocument: { ...event.textDocument, uri },
  };
}

function canonicalDocumentConnection(
  connection: TextDocumentConnection,
  representatives: Map<string, string>,
): TextDocumentConnection {
  const representative = (uri: string): string => (
    representatives.get(uriKey(uri)) ?? uri
  );
  const forward = <T extends TextDocumentNotification>(
    handler: (event: T) => void,
    event: T,
  ): void => handler(withDocumentUri(event, representative(event.textDocument.uri)));

  const canonical: TextDocumentConnection = {
    onDidOpenTextDocument: (handler) => connection.onDidOpenTextDocument((event) => {
      const key = uriKey(event.textDocument.uri);
      const uri = representatives.get(key) ?? event.textDocument.uri;
      representatives.set(key, uri);
      handler(withDocumentUri(event, uri));
    }),
    onDidChangeTextDocument: (handler) => connection.onDidChangeTextDocument(
      (event) => forward(handler, event),
    ),
    onDidCloseTextDocument: (handler) => connection.onDidCloseTextDocument((event) => {
      const key = uriKey(event.textDocument.uri);
      try {
        forward(handler, event);
      } finally {
        representatives.delete(key);
      }
    }),
    onWillSaveTextDocument: (handler) => connection.onWillSaveTextDocument(
      (event) => forward(handler, event),
    ),
    onWillSaveTextDocumentWaitUntil: (handler) => (
      connection.onWillSaveTextDocumentWaitUntil(
        (event, token) => handler(
          withDocumentUri(event, representative(event.textDocument.uri)),
          token,
        ),
      )
    ),
    onDidSaveTextDocument: (handler) => connection.onDidSaveTextDocument(
      (event) => forward(handler, event),
    ),
  };

  // TextDocuments writes this hidden connection state while registering. The
  // forwarding property keeps initialize capabilities on the real connection.
  Object.defineProperty(canonical, '__textDocumentSync', {
    configurable: true,
    get: () => (connection as TextDocumentConnection & {
      __textDocumentSync?: unknown;
    }).__textDocumentSync,
    set: (value: unknown) => {
      (connection as TextDocumentConnection & {
        __textDocumentSync?: unknown;
      }).__textDocumentSync = value;
    },
  });
  return canonical;
}

class CanonicalTextDocuments extends TextDocuments<TextDocument> {
  private readonly representatives = new Map<string, string>();

  override get(uri: string): TextDocument | undefined {
    return super.get(this.representatives.get(uriKey(uri)) ?? uri);
  }

  override listen(connection: TextDocumentConnection) {
    const disposable = super.listen(canonicalDocumentConnection(
      connection,
      this.representatives,
    ));
    return {
      dispose: () => {
        disposable.dispose();
        this.representatives.clear();
      },
    };
  }
}

/**
 * Owns the editor-side open identity and routes immutable snapshots to the
 * Indexed Workspace behavior. Workspace owns parsing, ordering, and fallback.
 */
export function registerDocuments(
  connection: Connection,
  manager: IndexedWorkspaceService,
): RegisteredDocuments {
  const documents = new CanonicalTextDocuments(TextDocument);
  const openDocuments = new Map<string, IndexedDocumentSnapshot>();
  const pendingLazyRoutes = new Map<string, Promise<void>>();
  const pendingEditRoutes = new Map<string, ReturnType<typeof setTimeout>>();
  const closeSnapshotHandlers = new Set<(document: IndexedDocumentSnapshot) => void>();
  let nextOpenId = 1;

  const reportFailure = (action: string, uri: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    const formatted = `[UnityShaderNav] ${action} failed for ${uri}: ${message}`;
    if (typeof connection.console.error === 'function') {
      connection.console.error(formatted);
    } else {
      connection.console.log(formatted);
    }
  };

  const observe = (
    action: string,
    uri: string,
    operation: () => Promise<unknown>,
  ): void => {
    try {
      void operation().catch((error: unknown) => reportFailure(action, uri, error));
    } catch (error) {
      reportFailure(action, uri, error);
    }
  };

  const routeLatest = (uri: string): void => {
    const key = uriKey(uri);
    const latest = openDocuments.get(key);
    if (!latest) return;
    let routedSnapshot = latest;

    // Existing includes an initial/rebuilding Workspace. updateDocument records
    // the desired attempt synchronously and coalesces behind its operation queue.
    const existing = manager.workspaceFor(latest.uri);
    if (existing) {
      observe('document update', latest.uri, () => existing.updateDocument(latest));
      return;
    }

    if (pendingLazyRoutes.has(key)) return;
    let route!: Promise<void>;
    route = (async () => {
      const workspace = await manager.workspaceForOrCreateFile(
        latest.uri,
        () => openDocuments.has(key),
      );
      const current = openDocuments.get(key);
      if (workspace && current) {
        routedSnapshot = current;
        await workspace.updateDocument(current);
        if (openDocuments.get(key) === current) cancelPendingEditRoute(key);
      }
    })()
      .catch((error: unknown) => reportFailure('document routing', latest.uri, error))
      .finally(() => {
        if (pendingLazyRoutes.get(key) !== route) return;
        pendingLazyRoutes.delete(key);
        const current = openDocuments.get(key);
        if (
          current
          && current !== routedSnapshot
          && !pendingEditRoutes.has(key)
        ) routeLatest(current.uri);
      });
    pendingLazyRoutes.set(key, route);
  };

  const cancelPendingEditRoute = (key: string): void => {
    const timer = pendingEditRoutes.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingEditRoutes.delete(key);
  };

  const routeLatestAfterEditWindow = (uri: string): void => {
    const key = uriKey(uri);
    cancelPendingEditRoute(key);
    const timer = setTimeout(() => {
      if (pendingEditRoutes.get(key) !== timer) return;
      pendingEditRoutes.delete(key);
      routeLatest(uri);
    }, LIVE_EDIT_COALESCE_MS);
    pendingEditRoutes.set(key, timer);
  };

  const publish = (
    document: TextDocument,
    openId: number,
    coalesceEdit = false,
  ): void => {
    const snapshot = snapshotDocument(document, openId);
    const key = uriKey(snapshot.uri);
    const current = openDocuments.get(key);
    if (current?.openId === snapshot.openId) {
      if (snapshot.version < current.version) return;
      if (snapshot.version === current.version) {
        // TextDocuments emits didChangeContent immediately after didOpen. The
        // identical attempt must not create a second route or parse.
        if (
          snapshot.text === current.text
          && snapshot.languageId === current.languageId
        ) return;
        reportFailure(
          'document update',
          snapshot.uri,
          new Error(`conflicting text for version ${snapshot.version}`),
        );
        return;
      }
    } else if (current && snapshot.openId < current.openId) {
      return;
    }

    openDocuments.set(key, snapshot);
    if (coalesceEdit) {
      routeLatestAfterEditWindow(snapshot.uri);
    } else {
      cancelPendingEditRoute(key);
      routeLatest(snapshot.uri);
    }
  };

  manager.configureOpenDocumentsProvider(() => openDocuments.values());

  documents.onDidOpen(({ document }) => {
    publish(document, nextOpenId++);
  });
  documents.onDidChangeContent(({ document }) => {
    const current = openDocuments.get(uriKey(document.uri));
    if (!current) return;
    publish(document, current.openId, true);
  });
  documents.onDidClose(({ document }) => {
    const key = uriKey(document.uri);
    const current = openDocuments.get(key);
    if (!current) return;
    cancelPendingEditRoute(key);
    openDocuments.delete(key);
    for (const handler of closeSnapshotHandlers) {
      try {
        handler(current);
      } catch (error) {
        reportFailure('document close notification', current.uri, error);
      }
    }

    const workspace = manager.workspaceFor(document.uri);
    if (workspace) {
      observe('document close', document.uri, () => workspace.closeDocument({
        uri: document.uri,
        openId: current.openId,
      }));
    }
    observe('document release', document.uri, () => manager.releaseDocument(document.uri));
  });

  documents.listen(connection);
  return {
    documents,
    snapshot: (uri) => openDocuments.get(uriKey(uri)),
    openSnapshots: () => [...openDocuments.values()],
    onDidCloseSnapshot: (handler) => { closeSnapshotHandlers.add(handler); },
  };
}
