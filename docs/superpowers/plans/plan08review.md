# Plan 08 Code Review

Date: 2026-05-23
Branch: `plan08-index-lifecycle`
Range: `main..HEAD` (`a99bb7c..544376c`)

## Main Agent Quick Review

### P2: settings changes reuse bootstrap without clearing stale indexes

- File: `unity-shader-nav/server/src/server.ts`
- Finding: `onSettingsChanged()` updates workspace settings and calls `workspace.bootstrap(connection)` directly. `bootstrap()` rescans but does not clear `store`, `global`, or `diskIndexes`.
- Impact: when `projectRoot` changes, package mappings change, or `excludePatterns` become stricter, stale symbols from the previous scan can remain addressable.
- Suggested fix: route settings changes through the same clearing rebuild path used for lifecycle rebuilds, then reindex open documents.

## Independent Code Review Subagent

Reviewer: `019e5255-3233-79e2-81ce-2d460f78ba4b`

### P1: rebuild drops live document overlays

- File: `unity-shader-nav/server/src/workspace/workspace.ts`
- Finding: `Workspace.rebuild()` clears `store/global/diskIndexes` and only runs disk `bootstrap()`. It cannot restore currently-open unsaved documents because live state is local to `registerDocuments()`.
- Impact: after `.git/HEAD`, `packages-lock.json`, or threshold rebuild, unsaved open documents can fall back to stale disk indexes. Standalone open-file workspaces can lose F12 because `fullScan()` returns immediately.
- Suggested fix: move rebuild orchestration to a layer that can access `documents.all()`, or pass a live document callback into the lifecycle dispatcher; rebuild disk first, then reindex open documents before releasing suspended requests.

### P2: settings changes leave stale roots and excluded files

- File: `unity-shader-nav/server/src/server.ts`
- Finding: settings changes call `workspace.bootstrap(connection)` without clearing previous indexes.
- Impact: switching `projectRoot` or tightening `excludePatterns` can leave old symbols in `store/global/diskIndexes`.
- Suggested fix: settings changes should use the same clear-and-rebuild flow as file lifecycle rebuilds and restore open documents afterward. Add tests for projectRoot A to B and exclude pattern cleanup.

### P2: meta watchers ignore create/delete events

- File: `unity-shader-nav/client/src/watcher.ts`
- Finding: `.git/HEAD` and `Packages/packages-lock.json` only forward `onDidChange`.
- Impact: git checkout or Unity lockfile writes can replace files atomically and surface as create/delete, causing missed rebuilds.
- Suggested fix: forward create/change/delete for both meta watchers.

### P2: integration tests can pass without proving watcher/rebuild behavior

- Files:
  - `unity-shader-nav/tests/integration/client/lifecycle.test.ts`
  - `unity-shader-nav/tests/integration/client/rebuild-on-branch.test.ts`
- Finding: `ensureWorkspaceFolder()` silently returns when adding a workspace fails, and tests can pass via lazy `workspaceForOrCreateFile()` scanning. The branch test checks old `Common()` still works, not that rebuild removed stale state or picked up new disk state.
- Impact: tests may be false positives if FileSystemWatcher forwarding or rebuild dispatch is broken.
- Suggested fix: assert workspace folder addition succeeds; prove a symbol is initially absent/stale, trigger external file or `.git/HEAD` change, then assert the new/rebuilt state appears.

### P3: RequestSuspender is not safe for overlapping suspensions

- File: `unity-shader-nav/server/src/lifecycle/requestSuspender.ts`
- Finding: suspension is a boolean. If cold start and rebuild overlap, the first release unsuspends all waiters while the second operation is still running.
- Impact: definitions can run during an active rebuild.
- Suggested fix: make suspension ref-counted or token-based and only release waiters when the last suspension ends. Add a test for overlapping `suspend()` calls.

## Verification Already Run

- `npm run test -w @unity-shader-nav/server`: PASS, 32 files / 132 tests.
- `npx tsc -p tests/tsconfig.json && node tests/out/runTest.js`: PASS after test cleanup retry fix, 15 test-electron cases.

