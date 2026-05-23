# Phase 05-10 Full Review

Review date: 2026-05-23

Scope:
- Phase/Plan 05 through 10 implementation, fixes, and review documents.
- Main code under `unity-shader-nav/server/src/macros`, `include`, `packages`, `workspace`, `lifecycle`, `cache`, `handlers`, and `index`.
- Client lifecycle/config forwarding under `unity-shader-nav/client/src`.
- Existing docs: `plan05review/fix` through `plan10review/fix`, `phase01-05review.md`, and `docs/superpowers/PROGRESS.md`.

Subagents:
- `Lagrange` (`019e53ba-6293-7ab2-93df-e4dd4778db3e`) reviewed Plan 05-07. Verdict: no P1, two P2 findings.
- `Faraday` (`019e53ba-a00d-7fb0-a9a4-e450b54057ac`) reviewed Plan 08-10. Verdict: no P1, two P2 findings.
- `Hume` (`019e53c6-f9bf-79f2-add5-befd6d6608ce`) did a timeboxed Plan 08-10 cross-check. Verdict: two P1 findings matching Faraday's P2s, plus one P2 finding.

## Findings

### P1 - Standalone cache persisted unsaved live buffers

Status: confirmed, fixed in this review.

`Workspace.reindex()` wrote standalone live document indexes into `diskIndexes`, and `persist()` serialized `diskIndexes` using the real file's `(mtime, size)`. If a standalone buffer had unsaved changes, the cache could validate on the next bootstrap and resurrect symbols that never existed on disk.

Fix:
- Standalone `reindex()` now refreshes `diskIndexes` from the current disk bytes.
- If live text matches disk text, it reuses the live index; otherwise it parses disk text separately.
- Missing/unreadable files are removed from standalone disk cache state.

Regression:
- Disk text `SavedOnly()` plus live text `UnsavedOnly()` no longer restores `UnsavedOnly()` after cache roundtrip.

### P1 - Lazy workspaces ignored scoped settings

Status: confirmed, fixed in this review.

Explicit workspace folders now load scoped settings, but `WorkspaceManager.workspaceForOrCreateFile()` still created lazy workspaces from the last global settings snapshot. Definition and Document Symbols both use lazy workspace creation for standalone/external files, so scoped `projectRoot`, `includeDirectories`, `declarationMacros`, and cache fingerprints could diverge from explicit-folder behavior.

Fix:
- `WorkspaceManager` now accepts a scoped settings resolver.
- The server wires it to `loadSettings(connection, scopeUri)`.
- Lazy workspace creation resolves settings for the target file URI before bootstrapping.

Regression:
- A lazy external file with scoped `projectRoot` and custom macro settings creates a workspace with the expected Unity root and macro table.

### P2 - Include F12 did not share block-comment semantics with include indexing

Status: confirmed, fixed in this review.

Plan 06 fixed `scanIncludes()` so indexing ignores `#include` inside multi-line block comments. The definition handler, however, scanned only the current line, so block-comment state always started as `false`. A commented include could still navigate even though it was not indexed.

Fix:
- Include F12 now scans the full document and matches the directive on the requested line/range.

Regression:
- F12 on `#include "Common.hlsl"` inside `/* ... */` returns `null`.

### P2 - Multi-root settings could leak `projectRoot` across workspaces

Status: confirmed, fixed in this review.

The server initially loaded settings globally and reused them for every workspace. Since `Workspace.bootstrap()` correctly gives `settings.projectRoot` priority over auto-detection, one folder's configured project root could make another workspace scan the wrong Unity project, breaking Plan 07 multi-root isolation.

Fix:
- Initial workspace bootstrap and later folder additions now call `loadSettings(connection, folder.uri)`.
- Settings-change rebuilds apply settings per workspace through `applyScopedSettingsAndRebuild()`.
- `WorkspaceManager.addFolder()` now uses the settings explicitly passed for that folder instead of overriding with a cached global snapshot.

Regression:
- Project A can use scoped `projectRoot` while Project B auto-detects itself, and Project B's global index does not expose Project A's `Common` symbol.

### P2 - Document Symbols could return `null` before open-document indexing finished

Status: confirmed, fixed in this review.

`registerDocuments()` starts open/change reindex asynchronously. The Document Symbol handler read `workspace.store` directly, so an immediate Outline request for a just-opened standalone or unsaved file could return `null` before the async reindex finished.

Fix:
- On a store miss, the Document Symbol handler now checks the open document, indexes it on demand, and then builds symbols.

Regression:
- Handler-level test covers a store miss with an open document and expects `LiveOutline` on the first response.

### P2 - Cache write failures could fail indexing requests

Status: confirmed, fixed in this review.

Focused parallel verification hit a Windows `EPERM` rename when multiple tests wrote the same fixture cache manifest path. This is related to the existing Plan 09 deferred cross-process cache hardening risk. Cache persistence is an optimization, so a cache write failure should not break workspace bootstrap or navigation.

Fix:
- `Workspace.persist()` now treats cache save failures as best-effort and keeps the in-memory index usable.

Remaining follow-up:
- Full cross-process lockfile/atomic replace hardening remains deferred, as already recorded in Plan 09.

### P3 - File watcher fake-timer test did not await async timer work

Status: confirmed, fixed in this review.

After settings rebuild gained an async pre-rebuild hook, `fileWatcher.test.ts` still used synchronous fake-timer advancement plus manual microtask flushing. That could assert before rebuild/open-document restoration finished.

Fix:
- The affected watcher tests now use `vi.advanceTimersByTimeAsync(501)`.

## Rechecked Deferred Items

- Plan 05 CG legacy declarations remain deferred; top-level ordinary HLSL globals were already fixed in `phase01-05review.md`.
- Plan 05 unmatched macro sentinel reference noise remains deferred for Plan 13 Find References.
- Plan 09 cross-process cache manifest hardening remains deferred, but cache save failures no longer surface as indexing failures.

## Verification

Focused RED/GREEN checks were run for each fixed area:

- `definition-include.test.ts`: RED showed commented include F12 returned a link; GREEN passed 2/2.
- `rebuild.test.ts` and `workspaceManager.test.ts`: RED showed missing scoped-settings API; GREEN passed.
- `workspace.test.ts`: RED showed `UnsavedOnly` restored from cache; GREEN passed 10/10.
- `documentSymbol.test.ts`: RED showed store-miss Outline returned `null`; GREEN passed 3/3.

Additional focused verification after fixes:

- `npm run build`
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/definition-include.test.ts tests/lifecycle/rebuild.test.ts tests/workspace/workspaceManager.test.ts tests/config/settings.test.ts tests/include/resolver.test.ts tests/packages/lockfile.test.ts tests/index/documentSymbols.test.ts tests/handlers/documentSymbol.test.ts tests/cache/cacheStore.test.ts tests/cache/cacheManager.test.ts`
- `npm run test -w @unity-shader-nav/server -- --run tests/handlers/documentSymbol.test.ts tests/workspace/workspace.test.ts tests/workspace/workspaceManager.test.ts`
- `npm run test -w @unity-shader-nav/server -- --run tests/lifecycle/fileWatcher.test.ts`
- `npm test`
