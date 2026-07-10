import type { FileIndex } from '@unity-shader-nav/shared';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { TextDocuments } from 'vscode-languageserver/node';
import { collectVisibleUriKeys } from '../index';
import type { GlobalReferenceIndex, GlobalSymbolIndex, IndexStore } from '../index';
import type { IncludeContext } from '../include';
import type { Workspace, WorkspaceManager } from '../workspace';

/**
 * The resolved request context shared by every navigation/query handler. It owns
 * the copy-pasted preamble — document lookup, workspace resolution, the index
 * reindex-fallback, and the include-visibility walk — behind one seam so handlers
 * shrink to `context → LSP result` and stop reaching into workspace internals.
 *
 * Workspace-derived fields are exposed as lazy getters and `index()` /
 * `visibleUriKeys()` as lazy memoized promises: a field or walk is only evaluated
 * when a handler actually reads it. That preserves each handler's existing ordering
 * of cheap-check-vs-reindex-vs-visibility (e.g. completion's comment/string early
 * return runs before any reindex), and keeps the `requireDocument:false` handlers
 * from dereferencing fields their fixtures never provide (`packages`, `globalRefs`).
 */
export interface RequestContext {
  /**
   * The open document. Guaranteed present when `requireDocument` is true (the
   * default); for `requireDocument:false` callers it may be undefined at runtime,
   * so those handlers read it defensively (`ctx.doc?.getText()`).
   */
  readonly doc: TextDocument;
  readonly workspace: Workspace;
  readonly store: IndexStore;
  readonly global: GlobalSymbolIndex;
  readonly globalRefs: GlobalReferenceIndex;
  readonly includeCtx: IncludeContext;
  /**
   * Lazy, memoized: `store.get(uri)`; if missing and a document is available,
   * reindex it and `store.get(uri)` again. The promise is memoized so reindex
   * runs at most once per request even across repeated calls.
   */
  index(): Promise<FileIndex | undefined>;
  /** Lazy, memoized: `collectVisibleUriKeys(store, includeCtx, uri)`. */
  visibleUriKeys(): Promise<Set<string>>;
}

export interface ResolveRequestContextOptions {
  /**
   * When true (default), a missing document short-circuits to `null` before the
   * workspace lookup — matching the position handlers' "no document → null" guard.
   * Set false for the position-less handlers (documentSymbol / semanticTokens),
   * which can still answer from an already-indexed store without an open document.
   */
  requireDocument?: boolean;
}

/**
 * Turn LSP request params into a resolved {@link RequestContext}, or `null` when
 * the request cannot be served (no document when required, or no workspace).
 */
export async function resolveRequestContext(
  uri: string,
  documents: TextDocuments<TextDocument>,
  manager: WorkspaceManager,
  options: ResolveRequestContextOptions = {},
): Promise<RequestContext | null> {
  const { requireDocument = true } = options;

  // Memoized (flag-guarded, not `??=`: `undefined` is a valid resolved value).
  let docResolved = false;
  let docValue: TextDocument | undefined;
  const getDoc = (): TextDocument | undefined => {
    if (!docResolved) {
      docResolved = true;
      docValue = documents.get(uri);
    }
    return docValue;
  };

  if (requireDocument && !getDoc()) return null;

  const workspace = await manager.workspaceForOrCreateFile(uri);
  if (!workspace) return null;

  // Memoize the promise so the reindex runs at most once even under concurrent awaits.
  let indexPromise: Promise<FileIndex | undefined> | undefined;
  const index = (): Promise<FileIndex | undefined> =>
    (indexPromise ??= (async (): Promise<FileIndex | undefined> => {
      let idx = workspace.index.store.get(uri);
      if (!idx && typeof workspace.index?.reindex === 'function') {
        const doc = getDoc();
        if (doc) {
          await workspace.index.reindex(doc.uri, doc.getText());
          idx = workspace.index.store.get(uri);
        }
      }
      return idx;
    })());

  let visiblePromise: Promise<Set<string>> | undefined;
  const visibleUriKeys = (): Promise<Set<string>> =>
    (visiblePromise ??= collectVisibleUriKeys(
      workspace.index.store,
      workspace.packages.includeCtx,
      uri,
    ));

  return {
    get doc() {
      return getDoc() as TextDocument;
    },
    workspace,
    get store() {
      return workspace.index.store;
    },
    get global() {
      return workspace.index.global;
    },
    get globalRefs() {
      return workspace.index.globalRefs;
    },
    get includeCtx() {
      return workspace.packages.includeCtx;
    },
    index,
    visibleUriKeys,
  };
}
