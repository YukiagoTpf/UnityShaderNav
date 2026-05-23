# Plan 09 Fix Notes

Source review: `docs/superpowers/plans/plan09review.md`

Fix scope: two P2 findings only. The P3 cross-process atomic cache write hardening is deferred.

## Fixed

### P2: Standalone cache fallback restore

- Added a regression test that creates a temporary standalone folder and a temporary `globalStorageDir`, indexes a real `.hlsl` file through `Workspace.reindex()`, persists, then boots a new `Workspace` and verifies the symbol is restored.
- Changed standalone `Workspace.bootstrap()` to load the configured cache manifest from `globalStorageDir/standalone/<hash>/index.json` when the fingerprint and workspace match.
- Changed standalone `Workspace.reindex()` to update `diskIndexes` so opened standalone files are included in `persist()`.
- Kept Unity workspace live overlay behavior unchanged: Unity `reindex()` still does not overwrite full-scan `diskIndexes`, so `closeDocument()` can restore the disk index.

### P2: packages-lock warm cache filtering

- Added a regression test that caches `com.example.render@oldhash`, changes `Packages/packages-lock.json` to `newhash` while leaving both old and new `Library/PackageCache` directories on disk, then verifies a warm bootstrap drops `OldPackageSymbol` and indexes `NewPackageSymbol`.
- Changed cache restore to skip cached files under `Packages/` or `Library/PackageCache/` unless they are inside one of the currently resolved `PackageResolver.allPaths()` roots.
- The skipped stale package entries are omitted from the next persisted manifest after bootstrap.

## Deferred

- P3: cross-process cache write hardening remains a follow-up. Current writes are serialized only within one Node process; cache is rebuildable, so this fix does not broaden scope into inter-process locking or atomic replacement changes.

## Verification

- Red test run before implementation:
  - `npm run test -w @unity-shader-nav/server -- --run tests/workspace/workspace.test.ts -t "persists opened standalone files|does not restore cached package"` failed with the expected standalone restore miss and stale old package symbol.
- Green focused run after implementation:
  - Same command: 2 focused tests passed.
- Workspace regression run:
  - `npm run test -w @unity-shader-nav/server -- --run tests/workspace/workspace.test.ts`: 9/9 passed.
- Final verification:
  - `npm run test -w @unity-shader-nav/server`: 38 files / 159 tests passed.
  - `npm run build`: shared/server/client TypeScript builds passed; copy-server and bundle completed.
