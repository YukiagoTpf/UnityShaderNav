import type { Connection } from 'vscode-languageserver/node';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { uriKey } from '../uriKey';
import {
  snapshotDocument,
  type IndexedDocumentSnapshot,
  type IndexedDocumentRegistry,
  type IndexedWorkspaceService,
} from '../workspace/indexedWorkspace';

export interface RegisteredDocuments extends IndexedDocumentRegistry {
  readonly documents: TextDocuments<TextDocument>;
}

type TextDocumentConnection = Parameters<TextDocuments<TextDocument>['listen']>[0];
type TextDocumentNotification = { readonly textDocument: { readonly uri: string } };

function canonicalizeDocumentUri<T extends TextDocumentNotification>(event: T): T {
  const uri = uriKey(event.textDocument.uri);
  if (uri === event.textDocument.uri) return event;
  return {
    ...event,
    textDocument: { ...event.textDocument, uri },
  };
}

function canonicalDocumentConnection(
  connection: TextDocumentConnection,
): TextDocumentConnection {
  const canonical: TextDocumentConnection = {
    onDidOpenTextDocument: (handler) => connection.onDidOpenTextDocument(
      (event) => handler(canonicalizeDocumentUri(event)),
    ),
    onDidChangeTextDocument: (handler) => connection.onDidChangeTextDocument(
      (event) => handler(canonicalizeDocumentUri(event)),
    ),
    onDidCloseTextDocument: (handler) => connection.onDidCloseTextDocument(
      (event) => handler(canonicalizeDocumentUri(event)),
    ),
    onWillSaveTextDocument: (handler) => connection.onWillSaveTextDocument(
      (event) => handler(canonicalizeDocumentUri(event)),
    ),
    onWillSaveTextDocumentWaitUntil: (handler) => (
      connection.onWillSaveTextDocumentWaitUntil(
        (event, token) => handler(canonicalizeDocumentUri(event), token),
      )
    ),
    onDidSaveTextDocument: (handler) => connection.onDidSaveTextDocument(
      (event) => handler(canonicalizeDocumentUri(event)),
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
  override get(uri: string): TextDocument | undefined {
    return super.get(uriKey(uri));
  }

  override listen(connection: TextDocumentConnection) {
    return super.listen(canonicalDocumentConnection(connection));
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
    const routedOpenId = latest.openId;

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
      if (workspace && current) await workspace.updateDocument(current);
    })()
      .catch((error: unknown) => reportFailure('document routing', latest.uri, error))
      .finally(() => {
        if (pendingLazyRoutes.get(key) !== route) return;
        pendingLazyRoutes.delete(key);
        const current = openDocuments.get(key);
        if (current && current.openId !== routedOpenId) routeLatest(current.uri);
      });
    pendingLazyRoutes.set(key, route);
  };

  const publish = (document: TextDocument, openId: number): void => {
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
    routeLatest(snapshot.uri);
  };

  manager.configureOpenDocumentsProvider(() => openDocuments.values());

  documents.onDidOpen(({ document }) => {
    publish(document, nextOpenId++);
  });
  documents.onDidChangeContent(({ document }) => {
    const current = openDocuments.get(uriKey(document.uri));
    if (!current) return;
    publish(document, current.openId);
  });
  documents.onDidClose(({ document }) => {
    const key = uriKey(document.uri);
    const current = openDocuments.get(key);
    if (!current) return;
    openDocuments.delete(key);

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
  };
}
