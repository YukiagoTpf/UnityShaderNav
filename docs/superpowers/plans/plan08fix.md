# Plan 08 Review Fix

Date: 2026-05-23
Branch: `plan08-index-lifecycle`

## Findings Addressed

- P1 live overlay during rebuild: added rebuild orchestration in `server/src/lifecycle/rebuild.ts`. Full rebuild now suspends requests, clears and rescans disk indexes, reindexes every currently open document through a callback supplied by `server.ts`, then releases the suspender. This keeps standalone open-file workspaces and unsaved open buffers available after rebuild.
- P2 settings change cleanup: `onSettingsChanged()` now uses the same clean rebuild path as watcher-triggered rebuilds. Workspace settings and macro tables are updated before rebuild, stale `store` / `global` / `diskIndexes` entries are cleared by `Workspace.rebuild()`, and open documents are restored afterward. Added stale exclude cleanup coverage.
- P2 meta watcher events: `client/src/watcher.ts` now forwards create, change, and delete for both `**/.git/HEAD` and `**/Packages/packages-lock.json`.
- P2 integration tests: Plan 08 workspace-folder helpers now assert `updateWorkspaceFolders()` success. The lifecycle test proves `NewlyAdded` is not visible before the external `Common.hlsl` write, then becomes visible through watcher indexing. The branch smoke now changes disk state to `BranchOnly`, touches `.git/HEAD`, and checks the new symbol appears while stale `Common` disappears.
- P3 RequestSuspender overlap: `RequestSuspender` now uses a ref-counted suspension depth. Waiters run only after the final matching release. Added overlapping suspend/release coverage.

## Verification

- `npm run test -w @unity-shader-nav/server -- --run tests/lifecycle/requestSuspender.test.ts tests/lifecycle/fileWatcher.test.ts tests/lifecycle/rebuild.test.ts` - PASS, 11 tests.
- `npm run test -w @unity-shader-nav/server` - PASS, 33 files / 136 tests.
- `npm run build` - PASS.
- `npx tsc -p tests/tsconfig.json` - PASS.
- `node tests/out/runTest.js` - PASS by exit code 0; captured run ended with `15 passing`. The test-electron log still includes noisy VSCode workspace-folder validation messages for previously deleted temp directories.
